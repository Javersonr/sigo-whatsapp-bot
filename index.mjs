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

  const data = await resp.json().catch(() => ({}))

  console.log('[WhatsApp][RESPONSE STATUS]', resp.status)
  console.log('[WhatsApp][RESPONSE BODY]', JSON.stringify(data, null, 2))

  if (!resp.ok) {
    throw new Error(`Erro ao enviar mensagem WhatsApp: ${resp.status}`)
  }

  return data
}

// 🔹 Resposta simples para TEXTO (depois você pode trocar por IA/Mocha)
async function responderIA(texto) {
  return `Recebido: ${texto}`
}

// 🔹 Buscar metadados da mídia no WhatsApp (pega URL e mime_type)
async function buscarInfoMidiaWhatsApp(mediaId) {
  const url = `${GRAPH_API_BASE}/${mediaId}`

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

  return {
    buffer,
    mimeType: info.mime_type || 'application/octet-stream',
    fileName: info.id || 'arquivo',
    fileUrl: info.url || null,
  }
}

// 🔹 Fazer OCR + interpretação no próprio bot (OpenAI Vision)
async function processarImagemComOCR(buffer, mimeType = 'image/jpeg') {
  if (!openaiClient) {
    throw new Error('OPENAI_API_KEY não configurado')
  }

  const base64 = buffer.toString('base64')
  const dataUrl = `data:${mimeType};base64,${base64}`

  const resp = await openaiClient.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'Você é um extrator de informações de comprovantes, notas fiscais e boletos. ' +
          'Retorne APENAS um JSON válido com os campos: fornecedor, cnpj, valor, data, descricao, texto_completo. ' +
          'Valor como número (ponto decimal, ex: 1234.56). Data no formato YYYY-MM-DD quando possível.',
      },
      {
        role: 'user',
        content: [
          {
            type: 'text', // ✅ aqui é "text"
            text: 'Extraia os dados estruturados deste comprovante/nota.',
          },
          {
            type: 'image_url', // ✅ aqui é "image_url"
            image_url: {
              url: dataUrl,
            },
          },
        ],
      },
    ],
  })

  console.log('[OCR][RAW MESSAGE]', resp.choices[0].message)

  let dados = {
    fornecedor: '',
    cnpj: '',
    valor: '',
    data: '',
    descricao: '',
    texto_completo: '',
  }

  try {
    let content = resp.choices[0].message.content

    if (Array.isArray(content)) {
      content = content.map((c) => c.text || '').join('\n')
    }

    // tenta achar só o JSON dentro do texto (caso venha texto + explicação)
    const match = content.match(/\{[\s\S]*\}/)
    const jsonText = match ? match[0] : content

    const parsed = JSON.parse(jsonText)

    dados = {
      ...dados,
      ...parsed,
    }
  } catch (e) {
    console.error('[OCR] Erro ao fazer parse do JSON:', e)

    let raw = resp.choices[0].message.content
    if (Array.isArray(raw)) {
      raw = raw.map((c) => c.text || '').join('\n')
    }
    dados.texto_completo = raw
  }

  return dados
}


// 🔹 Enviar DADOS já processados para o endpoint da SIGO Obras (Mocha)
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
    try {
      let mediaId
      let fileName = 'arquivo'
      let mimeType = 'application/octet-stream'
      let fileUrlFromMeta = null

      if (type === 'document') {
        mediaId = message.document?.id
        fileName = message.document?.filename || fileName
        mimeType = message.document?.mime_type || mimeType
      }

      if (type === 'image') {
        mediaId = message.image?.id
        mimeType = message.image?.mime_type || mimeType
        fileName = `imagem_${mediaId || Date.now()}.jpg`
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

      console.log(`[Arquivo recebido de ${from}] mediaId=${mediaId}, filename=${fileName}`)

      // 1) Baixar arquivo do WhatsApp
      const midia = await baixarMidiaWhatsApp(mediaId)
      const buffer = midia.buffer
      const mime = mimeType || midia.mimeType

      // 2) OCR + interpretação (OpenAI)
      const dados = await processarImagemComOCR(buffer, mime)

      const fornecedor = dados.fornecedor || ''
      const cnpj = dados.cnpj || ''
      const valor = dados.valor || ''
      const dataDoc = dados.data || ''
      const descricao = dados.descricao || ''
      const textoCompleto = dados.texto_completo || ''

      // Se não encontrou nada estruturado, ainda assim tenta mandar o texto bruto pro Mocha
      if (!fornecedor && !cnpj && !valor && !dataDoc && !descricao) {
        if (textoCompleto) {
          try {
            await enviarDadosParaMochaOCR({
              userPhone: from,
              fileUrl: fileUrlFromMeta || midia.fileUrl || null,
              fornecedor: '',
              cnpj: '',
              valor: '',
              data: '',
              descricao: '',
              textoOcr: textoCompleto,
            })
          } catch (e) {
            console.error('[MOCHA OCR] Falha ao enviar texto bruto para SIGO Obras:', e)
          }
        }

        await enviarMensagemWhatsApp(
          from,
          'Recebi o arquivo, mas não consegui identificar claramente os dados do comprovante 😕\n\n' +
            'Tente enviar uma foto mais nítida, enquadrando só o documento, ou envie um PDF se tiver.'
        )
        return c.json({ status: 'ok' })
      }

      // 3) Enviar DADOS para SIGO Obras (Mocha)
      try {
        await enviarDadosParaMochaOCR({
          userPhone: from,
          fileUrl: fileUrlFromMeta || midia.fileUrl || null,
          fornecedor,
          cnpj,
          valor,
          data: dataDoc,
          descricao,
          textoOcr: textoCompleto,
        })
      } catch (e) {
        console.error('[MOCHA OCR] Falha ao enviar dados para SIGO Obras:', e)
      }

      // 4) Resumo pro usuário
      const valorFormatado =
        typeof valor === 'number'
          ? `R$ ${valor.toFixed(2).replace('.', ',')}`
          : valor.toString().includes('.') || valor.toString().includes(',')
          ? `R$ ${valor}`
          : valor || 'N/D'

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
