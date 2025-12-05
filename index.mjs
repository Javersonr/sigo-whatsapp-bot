import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import dotenv from 'dotenv'
import FormData from 'form-data'

dotenv.config()

// 🔹 Constantes da API do WhatsApp Cloud
const GRAPH_API_BASE = 'https://graph.facebook.com/v19.0'

// 🔹 Variáveis de ambiente
const VERIFY_TOKEN_META = process.env.VERIFY_TOKEN_META || 'sinergia123'
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || ''
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || ''
const MOCHA_OCR_URL = process.env.MOCHA_OCR_URL || ''
const PORT = Number(process.env.PORT || 3000)

if (!WHATSAPP_TOKEN) {
  console.warn('[WARN] WHATSAPP_TOKEN não definido.')
}
if (!PHONE_NUMBER_ID) {
  console.warn('[WARN] PHONE_NUMBER_ID não definido.')
}
if (!MOCHA_OCR_URL) {
  console.warn('[WARN] MOCHA_OCR_URL não definido.')
}

const app = new Hono()

// 🔹 Função para enviar mensagem de texto no WhatsApp
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

// 🔹 Função de resposta simples para TEXTO (aqui depois você pluga IA/Mocha)
async function responderIA(texto) {
  // Simples echo por enquanto
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
  }
}

// 🔹 Enviar arquivo (imagem/PDF) para o endpoint OCR do Mocha
async function enviarArquivoParaMochaOCR({ buffer, fileName, mimeType, userPhone, mediaId }) {
  if (!MOCHA_OCR_URL) {
    console.error('[ERRO] MOCHA_OCR_URL não configurado.')
    throw new Error('MOCHA_OCR_URL não configurado')
  }

  const form = new FormData()

  // Campo de arquivo
  form.append('file', buffer, {
    filename: fileName,
    contentType: mimeType,
  })

  // Demais campos
  form.append('filename', fileName)
  form.append('mime_type', mimeType)
  form.append('user_phone', userPhone)
  form.append('media_id', mediaId)

  const resp = await fetch(MOCHA_OCR_URL, {
    method: 'POST',
    headers: {
      ...form.getHeaders(),
    },
    body: form,
  })

  const data = await resp.json().catch(() => ({}))

  console.log('[MOCHA OCR][STATUS]', resp.status)
  console.log('[MOCHA OCR][RESPONSE]', JSON.stringify(data, null, 2))

  if (!resp.ok) {
    throw new Error(`Erro no OCR do Mocha: ${resp.status}`)
  }

  return data
}

// 🔹 Rota raiz – só pra teste rápido
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

  // 🟦 1) Mensagem de TEXTO
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

  // 🟨 2) Documento (PDF, etc.) ou Imagem (usaremos OCR do Mocha)
  if (type === 'document' || type === 'image') {
    try {
      let mediaId
      let fileName = 'arquivo'
      let mimeType = 'application/octet-stream'

      if (type === 'document') {
        mediaId = message.document?.id
        fileName = message.document?.filename || fileName
        mimeType = message.document?.mime_type || mimeType
      }

      if (type === 'image') {
        mediaId = message.image?.id
        mimeType = message.image?.mime_type || mimeType
        fileName = `imagem_${mediaId || Date.now()}.jpg`
      }

      if (!mediaId) {
        console.error('[ERRO] Nenhum mediaId encontrado na mensagem.')
        await enviarMensagemWhatsApp(from, 'Não consegui identificar o arquivo enviado. Tente novamente.')
        return c.json({ status: 'ok' })
      }

      console.log(`[Arquivo recebido de ${from}] mediaId=${mediaId}, filename=${fileName}`)

      // 1) Baixar o arquivo da API do WhatsApp
      const midia = await baixarMidiaWhatsApp(mediaId)

      const buffer = midia.buffer
      const mime = mimeType || midia.mimeType
      const name = fileName || midia.fileName

      // 2) Enviar para o OCR do Mocha
      const ocrData = await enviarArquivoParaMochaOCR({
        buffer,
        fileName: name,
        mimeType: mime,
        userPhone: from,
        mediaId,
      })

      const fornecedor = ocrData.fornecedor || 'N/D'
      const cnpj = ocrData.cnpj || 'N/D'
      const valor = ocrData.valor || 'N/D'
      const dataDoc = ocrData.data || 'N/D'
      const descricao = ocrData.descricao || 'N/D'

      const valorFormatado =
        typeof valor === 'number'
          ? `R$ ${valor.toFixed(2).replace('.', ',')}`
          : valor.toString().includes('.') || valor.toString().includes(',')
          ? `R$ ${valor}`
          : valor

      const msgResumo =
        `Recebi o seu comprovante ✅\n\n` +
        `Fornecedor: ${fornecedor}\n` +
        `CNPJ: ${cnpj}\n` +
        `Data: ${dataDoc}\n` +
        `Valor: ${valorFormatado}\n` +
        `Descrição: ${descricao}\n\n` +
        `Se estiver correto, responda *SIM* para lançar no financeiro.`

      await enviarMensagemWhatsApp(from, msgResumo)

      return c.json({ status: 'ok' })
    } catch (err) {
      console.error('[ERRO AO PROCESSAR DOCUMENTO/IMAGEM]', err)
      await enviarMensagemWhatsApp(from, 'Houve um erro ao processar seu arquivo. Tente novamente mais tarde.')
      return c.json({ status: 'error' })
    }
  }

  // Outros tipos: áudio, localização, etc.
  console.log(`[Tipo não tratado de ${from}]: ${type}`)
  await enviarMensagemWhatsApp(from, 'Por enquanto só consigo ler texto, imagens e PDFs.')
  return c.json({ status: 'ok' })
})

// 🔹 Sobe o servidor (Railway vai rodar isso)
serve({
  fetch: app.fetch,
  port: PORT,
})

console.log(`🚀 SIGO WHATSAPP BOT rodando na porta ${PORT}`)
