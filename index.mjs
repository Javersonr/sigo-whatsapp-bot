import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import dotenv from 'dotenv'
import OpenAI from 'openai'

dotenv.config()

// 🔹 Constantes da API do WhatsApp Cloud
const GRAPH_API_BASE = 'https://graph.facebook.com/v19.0'

// 🔹 Variáveis de ambiente
const VERIFY_TOKEN_META = process.env.VERIFY_TOKEN_META || 'sinergia123'
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || ''
const PHONE_NUMBER_ID =
  process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID || ''
const MOCHA_OCR_URL = process.env.MOCHA_OCR_URL || ''
const PORT = Number(process.env.PORT || 3000)

const openaiApiKey = process.env.OPENAI_API_KEY || ''
const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null

console.log('=== VARIÁVEIS DE AMBIENTE ===')
console.log('VERIFY_TOKEN_META:', VERIFY_TOKEN_META ? 'OK' : 'FALTA')
console.log('WHATSAPP_TOKEN:', WHATSAPP_TOKEN ? 'OK' : 'FALTA')
console.log('PHONE_NUMBER_ID:', PHONE_NUMBER_ID || 'FALTA')
console.log('MOCHA_OCR_URL: ', MOCHA_OCR_URL || 'FALTA')
console.log('OPENAI_API_KEY:', openaiApiKey ? 'OK' : 'FALTA')
console.log('==============================')

if (!WHATSAPP_TOKEN) {
  console.warn('[WARN] WHATSAPP_TOKEN não definido.')
}
if (!PHONE_NUMBER_ID) {
  console.warn('[WARN] PHONE_NUMBER_ID não definido.')
}
if (!MOCHA_OCR_URL) {
  console.warn('[WARN] MOCHA_OCR_URL não definido.')
}
if (!openaiApiKey) {
  console.warn('[WARN] OPENAI_API_KEY não definido. OCR não vai funcionar.')
}

const app = new Hono()

// 🔹 Mapa de pendências OCR (aguardando usuário responder "SIM")
const pendenciasOCR = new Map()
// chave: from (telefone), valor: { dadosOCR, fileUrl }

// --------------------------------------------------------
// 🧩 Funções auxiliares
// --------------------------------------------------------

// 🔹 Extrair JSON de uma resposta de texto da IA
function extrairJSON(content) {
  let texto = content

  if (Array.isArray(texto)) {
    texto = texto.map((c) => c.text || '').join('\n')
  }

  // Remove ```json ``` se vier formatado
  texto = texto.replace(/```json/gi, '').replace(/```/g, '').trim()

  const match = texto.match(/\{[\s\S]*\}/)
  const jsonText = match ? match[0] : texto

  try {
    return JSON.parse(jsonText)
  } catch (e) {
    console.error('[extrairJSON] Erro ao parsear JSON:', e)
    return {}
  }
}

// 🔹 Enviar mensagem de texto no WhatsApp
async function enviarMensagemWhatsApp(to, body) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.error('[ERRO] Faltam WHATSAPP_TOKEN ou PHONE_NUMBER_ID.')
    return
  }

  const url = `${GRAPH_API_BASE}/${PHONE_NUMBER_ID}/messages`

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body },
  }

  console.log('[WhatsApp][REQUEST]', JSON.stringify(payload, null, 2))

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  let data = {}
  try {
    data = await resp.json()
  } catch {
    data = {}
  }

  console.log('[WhatsApp][STATUS]', resp.status)
  console.log('[WhatsApp][RESPONSE]', JSON.stringify(data, null, 2))

  if (!resp.ok) {
    throw new Error(`Erro ao enviar mensagem WhatsApp: ${resp.status}`)
  }

  return data
}

// 🔹 Buscar metadados da mídia no WhatsApp
async function buscarInfoMidiaWhatsApp(mediaId) {
  const url = `${GRAPH_API_BASE}/${mediaId}`

  console.log('[WhatsApp][MEDIA INFO][GET]', url)

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
  })

  if (!resp.ok) {
    console.error('[WhatsApp][Media Info] Erro ao buscar mídia:', resp.status)
    throw new Error('Erro ao buscar info da mídia')
  }

  const data = await resp.json()
  console.log('[WhatsApp][MEDIA INFO][RESPONSE]', JSON.stringify(data, null, 2))
  return data // { url, mime_type, id, ... }
}

// 🔹 Baixar o arquivo binário da mídia no WhatsApp
async function baixarMidiaWhatsApp(mediaId) {
  const info = await buscarInfoMidiaWhatsApp(mediaId)

  const fileResp = await fetch(info.url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
  })

  if (!fileResp.ok) {
    console.error('[WhatsApp][Media Download] Erro ao baixar mídia:', fileResp.status)
    throw new Error('Erro ao baixar mídia')
  }

  const arrayBuffer = await fileResp.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  console.log('[WhatsApp][MEDIA DOWNLOAD] mime_type=', info.mime_type)

  return {
    buffer,
    mimeType: info.mime_type || 'application/octet-stream',
    fileUrl: info.url || null,
  }
}

// --------------------------------------------------------
// 🧠 OCR IMAGEM (Vision via image_url)
// --------------------------------------------------------
async function processarImagem(buffer, mimeType = 'image/jpeg') {
  if (!openai) throw new Error('OPENAI_API_KEY não configurado')

  const base64 = buffer.toString('base64')
  const dataUrl = `data:${mimeType};base64,${base64}`

  console.log('[OCR] Processando como IMAGEM...')

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'Você é um extrator de informações de comprovantes, notas fiscais e contas de consumo. ' +
          'Retorne APENAS um JSON válido com os campos: fornecedor, cnpj, valor, data, descricao, texto_completo. ' +
          'Valor como número (ponto decimal, ex: 1234.56). Data no formato DD/MM/YYYY ou YYYY-MM-DD.',
      },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: dataUrl,
            },
          },
          {
            type: 'text',
            text: 'Extraia os dados deste comprovante/nota/conta.',
          },
        ],
      },
    ],
  })

  console.log('[OCR IMAGEM][RAW MESSAGE]', resp.choices[0].message)

  const dados = extrairJSON(resp.choices[0].message.content)

  const final = {
    fornecedor: dados.fornecedor || '',
    cnpj: dados.cnpj || '',
    valor: dados.valor || '',
    data: dados.data || '',
    descricao: dados.descricao || '',
    texto_completo: dados.texto_completo || '',
  }

  console.log('[OCR] Dados extraídos:', final)
  return final
}

// --------------------------------------------------------
// 🧠 OCR PDF (enviado como FILE base64 para gpt-4o-mini)
// --------------------------------------------------------
async function processarPdf(buffer) {
  if (!openai) throw new Error('OPENAI_API_KEY não configurado')

  console.log('[OCR] Processando como PDF via FILE (base64)...')

  const base64 = buffer.toString('base64')

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'Você é um extrator de dados de comprovantes em PDF (boletos, notas fiscais, contas de energia, água, etc). ' +
          'Retorne APENAS um JSON válido com os campos: fornecedor, cnpj, valor, data, descricao, texto_completo. ' +
          'Valor como número (ponto decimal, ex: 1234.56). Data no formato DD/MM/YYYY ou YYYY-MM-DD.',
      },
      {
        role: 'user',
        content: [
          {
            type: 'file',
            file: {
              data: base64,
              mime_type: 'application/pdf',
            },
          },
          {
            type: 'text',
            text: 'Extraia os dados deste PDF de comprovante/nota/conta.',
          },
        ],
      },
    ],
  })

  console.log('[OCR PDF RAW MESSAGE]', resp.choices[0].message)

  const dados = extrairJSON(resp.choices[0].message.content)

  const final = {
    fornecedor: dados.fornecedor || '',
    cnpj: dados.cnpj || '',
    valor: dados.valor || '',
    data: dados.data || '',
    descricao: dados.descricao || '',
    texto_completo: dados.texto_completo || '',
  }

  console.log('[OCR PDF] Dados extraídos:', final)
  return final
}

// --------------------------------------------------------
// 🧠 Função ÚNICA de OCR (imagem ou pdf)
// --------------------------------------------------------
async function processarOCR(buffer, mimeType) {
  if (!mimeType) mimeType = 'application/octet-stream'

  if (mimeType.startsWith('image/')) {
    return await processarImagem(buffer, mimeType)
  }

  if (mimeType === 'application/pdf') {
    return await processarPdf(buffer)
  }

  console.log('[OCR] Tipo de arquivo não suportado para OCR automático. mime=', mimeType)
  return {
    fornecedor: '',
    cnpj: '',
    valor: '',
    data: '',
    descricao: '',
    texto_completo: '',
  }
}

// --------------------------------------------------------
// 🔄 Enviar DADOS para SIGO Obras (Mocha) – só após SIM
// --------------------------------------------------------
async function enviarDadosParaMochaOCR({
  userPhone,
  fileUrl,
  fornecedor,
  cnpj,
  valor,
  data,
  descricao,
  textoOcr,
}) {
  if (!MOCHA_OCR_URL) {
    console.error('[ERRO] MOCHA_OCR_URL não configurado.')
    throw new Error('MOCHA_OCR_URL não configurado')
  }

  const payload = {
    user_phone: userPhone,
    file_url: fileUrl,
    fornecedor,
    cnpj,
    valor,
    data,
    descricao,
    texto_ocr: textoOcr,
  }

  console.log('[MOCHA OCR][REQUEST]', JSON.stringify(payload, null, 2))

  const resp = await fetch(MOCHA_OCR_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  let dataResp = {}
  try {
    dataResp = await resp.json()
  } catch {
    dataResp = {}
  }

  console.log('[MOCHA OCR][STATUS]', resp.status)
  console.log('[MOCHA OCR][RESPONSE]', JSON.stringify(dataResp, null, 2))

  if (!resp.ok) {
    throw new Error(`Erro ao enviar dados OCR para Mocha: ${resp.status}`)
  }

  return dataResp
}

// --------------------------------------------------------
// 🤖 Resposta simples para TEXTO (inclui "SIM")
// --------------------------------------------------------
async function responderTexto(from, textoRecebido) {
  const normalizado = textoRecebido.trim().toUpperCase()

  // 1) Se usuário respondeu "SIM" e temos pendência -> envia pro Mocha
  if (normalizado === 'SIM') {
    const pendencia = pendenciasOCR.get(from)

    if (!pendencia) {
      return 'Não encontrei nenhum comprovante pendente para este número. Envie o arquivo novamente, por favor.'
    }

    const { dados, fileUrl } = pendencia

    try {
      await enviarDadosParaMochaOCR({
        userPhone: from,
        fileUrl: fileUrl || null,
        fornecedor: dados.fornecedor || '',
        cnpj: dados.cnpj || '',
        valor: dados.valor || '',
        data: dados.data || '',
        descricao: dados.descricao || '',
        textoOcr: dados.texto_completo || '',
      })

      pendenciasOCR.delete(from)

      return (
        'Perfeito! ✅\n' +
        'O lançamento já foi enviado para o SIGO Obras.\n' +
        'Se algo estiver errado, envie outro comprovante ou fale "ajuda".'
      )
    } catch (e) {
      console.error('[MOCHA OCR] Erro ao enviar depois do SIM:', e)
      return (
        'Tentei enviar o lançamento para o SIGO Obras, mas ocorreu um erro ⚠️\n' +
        'Por favor, tente novamente em alguns minutos ou envie o comprovante de novo.'
      )
    }
  }

  // 2) Qualquer outro texto
  return `Recebido: ${textoRecebido}`
}

// --------------------------------------------------------
// 🌐 Rota raiz – teste rápido
// --------------------------------------------------------
app.get('/', (c) => {
  return c.text('SIGO WHATSAPP BOT OK')
})

// --------------------------------------------------------
// 🌐 Verificação de webhook (GET) – configuração na Meta
// --------------------------------------------------------
app.get('/webhook/whatsapp', (c) => {
  const mode = c.req.query('hub.mode')
  const token = c.req.query('hub.verify_token')
  const challenge = c.req.query('hub.challenge')

  console.log('[Webhook GET] Recebido ->', { mode, token, challenge })

  if (mode === 'subscribe' && token === VERIFY_TOKEN_META) {
    console.log('[Webhook GET] Verificação OK')
    return c.text(challenge || '')
  }

  console.warn('[Webhook GET] Falha na verificação do webhook')
  return c.text('Erro na validação do webhook', 403)
})

// --------------------------------------------------------
// 🌐 Recebimento de mensagens (POST)
// --------------------------------------------------------
app.post('/webhook/whatsapp', async (c) => {
  const body = await c.req.json().catch(() => ({}))

  console.log('[Webhook POST] BODY RECEBIDO:')
  console.log(JSON.stringify(body, null, 2))

  const entry = body.entry?.[0]
  const change = entry?.changes?.[0]
  const value = change?.value
  const message = value?.messages?.[0]

  if (!message) {
    console.log('[Webhook POST] Nenhuma mensagem encontrada, ignorando.')
    return c.json({ status: 'ignored' })
  }

  const from = message.from
  const type = message.type

  // 🟦 1) TEXTO
  if (type === 'text') {
    const textoRecebido = message.text?.body || ''
    console.log(`[Texto recebido de ${from}]: ${textoRecebido}`)

    const resposta = await responderTexto(from, textoRecebido)

    try {
      await enviarMensagemWhatsApp(from, resposta)
    } catch (err) {
      console.error('[ERRO AO ENVIAR RESPOSTA TEXTO]', err)
    }

    return c.json({ status: 'ok' })
  }

  // 🟨 2) DOCUMENTO / IMAGEM (OCR)
  if (type === 'document' || type === 'image') {
    try {
      let mediaId
      let mimeType = 'application/octet-stream'
      let fileUrlFromMeta = null

      if (type === 'document') {
        mediaId = message.document?.id
        mimeType = message.document?.mime_type || mimeType
        fileUrlFromMeta = message.document?.url || null
      } else if (type === 'image') {
        mediaId = message.image?.id
        mimeType = message.image?.mime_type || mimeType
        fileUrlFromMeta = message.image?.url || null
      }

      if (!mediaId) {
        console.error('[ERRO] Nenhum mediaId encontrado na mensagem.')
        await enviarMensagemWhatsApp(
          from,
          'Não consegui identificar o arquivo enviado. Tente novamente.'
        )
        return c.json({ status: 'ok' })
      }

      console.log(`[Mensagem de ${from}] type=${type}`)
      console.log(
        `[Arquivo recebido de ${from}] mediaId=${mediaId} mimeType=${mimeType}`
      )

      // 1) Baixar arquivo
      const midia = await baixarMidiaWhatsApp(mediaId)
      const buffer = midia.buffer
      const mime = mimeType || midia.mimeType
      const fileUrl = fileUrlFromMeta || midia.fileUrl || null

      // 2) Rodar OCR (imagem/PDF)
      let dados = {
        fornecedor: '',
        cnpj: '',
        valor: '',
        data: '',
        descricao: '',
        texto_completo: '',
      }

      try {
        dados = await processarOCR(buffer, mime)
      } catch (e) {
        console.error('[ERRO OCR] ', e)
        await enviarMensagemWhatsApp(
          from,
          'Erro ao processar seu arquivo. Tente outra imagem ou PDF.'
        )
        return c.json({ status: 'error' })
      }

      const fornecedor = dados.fornecedor || ''
      const cnpj = dados.cnpj || ''
      const valor = dados.valor || ''
      const dataDoc = dados.data || ''
      const descricao = dados.descricao || ''
      const textoCompleto = dados.texto_completo || ''

      // 3) Se não extraiu nada → mensagem mais genérica
      if (!fornecedor && !cnpj && !valor && !dataDoc && !descricao) {
        if (mime === 'application/pdf') {
          await enviarMensagemWhatsApp(
            from,
            'Recebi o seu PDF 📄, mas não consegui identificar claramente os dados.\n\n' +
              'Se possível, envie também uma FOTO bem nítida do comprovante (apenas o documento) para melhorar a leitura.'
          )
        } else {
          await enviarMensagemWhatsApp(
            from,
            'Recebi o arquivo, mas não consegui identificar claramente os dados do comprovante 😕\n\n' +
              'Tente enviar uma foto mais nítida, enquadrando só o documento, com boa iluminação.'
          )
        }

        // Mesmo assim, não cria pendência se não tiver dados
        return c.json({ status: 'ok' })
      }

      // 4) Guardar pendência para aguardar "SIM"
      pendenciasOCR.set(from, {
        dados: {
          fornecedor,
          cnpj,
          valor,
          data: dataDoc,
          descricao,
          texto_completo: textoCompleto,
        },
        fileUrl,
      })

      // 5) Montar mensagem-resumo pro usuário
      const valorFormatado =
        typeof valor === 'number'
          ? `R$ ${valor.toFixed(2).replace('.', ',')}`
          : valor
          ? `R$ ${valor}`
          : 'N/D'

      const msgResumo =
        `Recebi o seu comprovante ✅\n\n` +
        `Fornecedor: ${fornecedor || 'N/D'}\n` +
        `CNPJ: ${cnpj || 'N/D'}\n` +
        `Data: ${dataDoc || 'N/D'}\n` +
        `Valor: ${valorFormatado}\n` +
        `Descrição: ${descricao || 'N/D'}\n\n` +
        `Se estiver correto, responda *SIM* para lançar no financeiro.`

      await enviarMensagemWhatsApp(from, msgResumo)

      return c.json({ status: 'ok' })
    } catch (err) {
      console.error('[ERRO AO PROCESSAR DOCUMENTO/IMAGEM]', err)

      await enviarMensagemWhatsApp(
        from,
        'Não consegui ler os dados desse arquivo 📄🖼️\n\n' +
          'Tente enviar outra imagem mais nítida (sem corte e com boa iluminação)\n' +
          'ou, se possível, envie o comprovante em PDF diretamente.'
      )

      return c.json({ status: 'error' })
    }
  }

  // Outros tipos
  console.log(`[Tipo não tratado de ${from}]: ${type}`)
  await enviarMensagemWhatsApp(from, 'Por enquanto só consigo ler texto, imagens e PDFs.')
  return c.json({ status: 'ok' })
})

// 🔹 Sobe o servidor
serve({
  fetch: app.fetch,
  port: PORT,
})

console.log(`🚀 SIGO WHATSAPP BOT rodando na porta ${PORT}`)
