// index.mjs

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
const openaiClient = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null

// 🔹 Log das variáveis principais
console.log('=== VARIÁVEIS DE AMBIENTE ===')
console.log('VERIFY_TOKEN_META:', VERIFY_TOKEN_META ? 'OK' : 'FALTANDO')
console.log('WHATSAPP_TOKEN:', WHATSAPP_TOKEN ? 'OK' : 'FALTANDO')
console.log('PHONE_NUMBER_ID:', PHONE_NUMBER_ID || 'FALTANDO')
console.log('MOCHA_OCR_URL: ', MOCHA_OCR_URL || 'FALTANDO')
console.log('OPENAI_API_KEY:', openaiApiKey ? 'OK' : 'FALTANDO')
console.log('==============================')

if (!WHATSAPP_TOKEN) console.warn('[WARN] WHATSAPP_TOKEN não definido.')
if (!PHONE_NUMBER_ID) console.warn('[WARN] PHONE_NUMBER_ID não definido.')
if (!MOCHA_OCR_URL) console.warn('[WARN] MOCHA_OCR_URL não definido.')
if (!openaiApiKey) console.warn('[WARN] OPENAI_API_KEY não definido. OCR não vai funcionar.')

const app = new Hono()

// 🔹 Memória simples para guardar último OCR pendente por usuário
const ocrPendentes = globalThis.ocrPendentes || (globalThis.ocrPendentes = {})

/**
 * 🔹 Enviar mensagem de texto no WhatsApp
 */
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

  const data = await resp.json().catch(() => ({}))

  console.log('[WhatsApp][STATUS]', resp.status)
  console.log('[WhatsApp][RESPONSE]', JSON.stringify(data, null, 2))

  if (!resp.ok) {
    console.error('[WhatsApp] Erro ao enviar mensagem:', resp.status, data)
    throw new Error(`Erro ao enviar mensagem WhatsApp: ${resp.status}`)
  }

  return data
}

/**
 * 🔹 Resposta simples para TEXTO (quando não for SIM)
 */
async function responderIA(texto) {
  return `Recebido: ${texto}`
}

/**
 * 🔹 Buscar metadados da mídia no WhatsApp
 */
async function buscarInfoMidiaWhatsApp(mediaId) {
  const url = `${GRAPH_API_BASE}/${mediaId}`

  console.log('[WhatsApp][MEDIA INFO][GET]', url)

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
  })

  const data = await resp.json().catch(() => ({}))

  console.log('[WhatsApp][MEDIA INFO][RESPONSE]', JSON.stringify(data, null, 2))

  if (!resp.ok) {
    console.error('[WhatsApp][Media Info] Erro ao buscar mídia:', resp.status, data)
    throw new Error('Erro ao buscar info da mídia')
  }

  return data // { url, mime_type, id, ... }
}

/**
 * 🔹 Baixar o arquivo binário da mídia no WhatsApp
 */
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

/**
 * 🔹 Helper para extrair JSON da resposta da OpenAI
 */
function extrairJsonDaResposta(message) {
  let content = message.content
  if (Array.isArray(content)) {
    content = content.map((c) => c.text || '').join('\n')
  }

  let cleaned = content
  cleaned = cleaned.replace(/```json/gi, '')
  cleaned = cleaned.replace(/```/g, '').trim()

  const match = cleaned.match(/\{[\s\S]*\}/)
  const jsonText = match ? match[0] : cleaned

  return JSON.parse(jsonText)
}

/**
 * 🔹 OCR IMAGEM (OpenAI Vision)
 */
async function processarImagem(buffer, mimeType = 'image/jpeg') {
  if (!openaiClient) {
    throw new Error('OPENAI_API_KEY não configurado')
  }

  console.log('[OCR] Processando como IMAGEM...')

  const base64 = buffer.toString('base64')
  const dataUrl = `data:${mimeType};base64,${base64}`

  const resp = await openaiClient.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'Você é um extrator de informações de comprovantes, notas fiscais, boletos e contas de consumo. ' +
          'Retorne APENAS um JSON com: fornecedor, cnpj, valor, data, descricao, texto_completo. ' +
          'Valor como número (ex: 1234.56). Data no formato DD/MM/YYYY ou YYYY-MM-DD.',
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Extraia os dados deste comprovante/nota fiscal/conta:',
          },
          {
            type: 'image_url',
            image_url: {
              url: dataUrl,
            },
          },
        ],
      },
    ],
  })

  console.log('[OCR IMAGEM][RAW MESSAGE]', resp.choices[0].message)

  let dadosBase = {
    fornecedor: '',
    cnpj: '',
    valor: '',
    data: '',
    descricao: '',
    texto_completo: '',
  }

  try {
    const parsed = extrairJsonDaResposta(resp.choices[0].message)
    const dados = { ...dadosBase, ...parsed }
    console.log('[OCR] Dados extraídos:', dados)
    return dados
  } catch (e) {
    console.error('[OCR IMAGEM] Erro ao parsear JSON:', e)
    let raw = resp.choices[0].message.content
    if (Array.isArray(raw)) {
      raw = raw.map((c) => c.text || '').join('\n')
    }
    return { ...dadosBase, texto_completo: raw }
  }
}

/**
 * 🔹 OCR PDF usando pdf-parse + texto na OpenAI
 */
async function processarPdf(buffer) {
  if (!openaiClient) {
    throw new Error('OPENAI_API_KEY não configurado')
  }

  console.log('[OCR PDF] Extraindo texto do PDF com pdf-parse...')

  let texto = ''

  try {
    // import dinâmico para evitar erro de default export
    const pdfParseModule = await import('pdf-parse')
    const pdfParseFn = pdfParseModule.default || pdfParseModule

    const parsed = await pdfParseFn(buffer)
    texto = (parsed.text || '').trim()

    console.log(
      '[OCR PDF] TEXTO EXTRAÍDO INICIAL:',
      texto.slice(0, 500).replace(/\s+/g, ' ')
    )
  } catch (e) {
    console.error('[OCR PDF] Erro ao extrair texto com pdf-parse:', e)
    texto = ''
  }

  let dadosBase = {
    fornecedor: '',
    cnpj: '',
    valor: '',
    data: '',
    descricao: '',
    texto_completo: texto,
  }

  if (!texto) {
    console.log('[OCR PDF] Nenhum texto extraído, retornando dados vazios.')
    return dadosBase
  }

  console.log('[OCR PDF] Enviando TEXTO para OpenAI...')

  const resp = await openaiClient.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'Você é um extrator de informações de comprovantes, notas fiscais, boletos ou comprovantes bancários. ' +
          'A partir do TEXTO fornecido, identifique os dados e retorne APENAS um JSON válido com os campos: ' +
          'fornecedor, cnpj, valor, data, descricao, texto_completo. ' +
          'Valor como número (ponto decimal, ex: 1234.56). Data no formato DD/MM/YYYY ou YYYY-MM-DD.',
      },
      {
        role: 'user',
        content:
          'Aqui está o texto de um documento (comprovante, nota ou boleto). ' +
          'Extraia os dados e devolva SOMENTE o JSON no formato solicitado, sem explicações adicionais:\n\n' +
          texto.substring(0, 12000),
      },
    ],
  })

  console.log('[OCR PDF][RAW MESSAGE]', resp.choices[0].message)

  try {
    const parsedJson = extrairJsonDaResposta(resp.choices[0].message)
    const dados = {
      ...dadosBase,
      ...parsedJson,
      texto_completo: texto,
    }
    console.log('[OCR] Dados extraídos (PDF):', dados)
    return dados
  } catch (e) {
    console.error('[OCR PDF] Erro ao parsear JSON da OpenAI:', e)
    return dadosBase
  }
}

/**
 * 🔹 Enviar DADOS para SIGO Obras (Mocha) – só depois do SIM
 */
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

// 🔹 Rota raiz – teste rápido
app.get('/', (c) => {
  return c.text('SIGO WHATSAPP BOT OK')
})

// 🔹 Verificação de webhook (GET) – configuração na Meta
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

// 🔹 Recebimento de mensagens (POST)
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

    const normalizado = textoRecebido.trim().toUpperCase()

    // 🔸 Fluxo de confirmação SIM – só aqui manda pro SIGO Obras
    if (normalizado === 'SIM') {
      const pendente = ocrPendentes[from]

      if (!pendente) {
        await enviarMensagemWhatsApp(
          from,
          'Não encontrei nenhum comprovante pendente para lançar. ' +
            'Envie primeiro uma foto ou PDF do comprovante.'
        )
        return c.json({ status: 'ok' })
      }

      try {
        console.log('[CONFIRMAÇÃO SIM] Enviando dados ao Mocha...', pendente)
        await enviarDadosParaMochaOCR(pendente)

        await enviarMensagemWhatsApp(
          from,
          'Perfeito! ✅\n' +
            'O lançamento foi enviado para o SIGO Obras.\n' +
            'Se algo estiver errado, envie outro comprovante ou fale "ajuda".'
        )

        delete ocrPendentes[from]
      } catch (e) {
        console.error('[MOCHA OCR] Erro ao enviar dados após SIM:', e)
        await enviarMensagemWhatsApp(
          from,
          'Tentei lançar no SIGO Obras, mas ocorreu um erro ao integrar com o sistema. ' +
            'Tente novamente em alguns minutos ou fale com o suporte.'
        )
      }

      return c.json({ status: 'ok' })
    }

    // 🔸 Outros textos – resposta simples
    const resposta = await responderIA(textoRecebido)

    try {
      await enviarMensagemWhatsApp(from, resposta)
    } catch (err) {
      console.error('[ERRO AO ENVIAR RESPOSTA TEXTO]', err)
    }

    return c.json({ status: 'ok' })
  }

  // 🟨 2) DOCUMENTO / IMAGEM
  if (type === 'document' || type === 'image') {
    console.log(`[Mensagem de ${from}] type=${type}`)
    try {
      let mediaId
      let mimeType = 'application/octet-stream'

      if (type === 'document') {
        mediaId = message.document?.id
        mimeType = message.document?.mime_type || mimeType
      }

      if (type === 'image') {
        mediaId = message.image?.id
        mimeType = message.image?.mime_type || mimeType
      }

      if (!mediaId) {
        console.error('[ERRO] Nenhum mediaId encontrado na mensagem.')
        await enviarMensagemWhatsApp(
          from,
          'Não consegui identificar o arquivo enviado. Tente novamente.'
        )
        return c.json({ status: 'ok' })
      }

      console.log(
        `[Arquivo recebido de ${from}] mediaId=${mediaId} mimeType=${mimeType}`
      )

      // 1) Baixar arquivo
      const midia = await baixarMidiaWhatsApp(mediaId)
      const buffer = midia.buffer
      const mime = mimeType || midia.mimeType
      const fileUrl = midia.fileUrl

      // 2) Rodar OCR adequado (imagem x pdf)
      let dados = {
        fornecedor: '',
        cnpj: '',
        valor: '',
        data: '',
        descricao: '',
        texto_completo: '',
      }

      if (mime.startsWith('image/')) {
        dados = await processarImagem(buffer, mime)
      } else if (mime === 'application/pdf') {
        dados = await processarPdf(buffer)
      } else {
        console.log('[OCR] Tipo de arquivo não suportado:', mime)
      }

      const fornecedor = dados.fornecedor || ''
      const cnpj = dados.cnpj || ''
      const valor = dados.valor || ''
      const dataDoc = dados.data || ''
      const descricao = dados.descricao || ''
      const textoCompleto = dados.texto_completo || ''

      // Normalizar valor para exibição
      let valorFormatado = 'N/D'
      if (typeof valor === 'number') {
        valorFormatado = `R$ ${valor.toFixed(2).replace('.', ',')}`
      } else if (typeof valor === 'string' && valor.trim()) {
        valorFormatado = valor
      }

      // Guardar como pendente para confirmação SIM
      ocrPendentes[from] = {
        userPhone: from,
        fileUrl: fileUrl,
        fornecedor,
        cnpj,
        valor,
        data: dataDoc,
        descricao,
        textoOcr: textoCompleto,
      }

      // Se não conseguiu extrair nada estruturado
      if (!fornecedor && !cnpj && !valor && !dataDoc && !descricao) {
        if (mime === 'application/pdf') {
          await enviarMensagemWhatsApp(
            from,
            'Recebi o seu PDF 📄 e já deixei pendente para análise no SIGO Obras.\n\n' +
              'A leitura automática não identificou claramente os dados. ' +
              'Se possível, também envie uma FOTO bem nítida do comprovante para melhorar a leitura.'
          )
        } else {
          await enviarMensagemWhatsApp(
            from,
            'Recebi o arquivo e já deixei pendente para análise no SIGO Obras, mas não consegui identificar ' +
              'claramente os dados do comprovante 😕\n\nTente enviar uma foto mais nítida, enquadrando só o documento.'
          )
        }

        return c.json({ status: 'ok' })
      }

      // Se conseguiu extrair dados estruturados
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
        'Erro ao processar seu arquivo. Tente outra imagem ou PDF.'
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
