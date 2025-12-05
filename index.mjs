import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import dotenv from 'dotenv'
import OpenAI from 'openai'
import * as pdfParse from 'pdf-parse'   // << CORREÇÃO AQUI!!!

dotenv.config()

// ===============================
// 🔹 Constantes da Meta API
// ===============================
const GRAPH_API_BASE = 'https://graph.facebook.com/v19.0'

// ===============================
// 🔹 Variáveis de ambiente
// ===============================
const VERIFY_TOKEN_META = process.env.VERIFY_TOKEN_META || 'sinergia123'
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || ''
const PHONE_NUMBER_ID =
  process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID || ''
const MOCHA_OCR_URL = process.env.MOCHA_OCR_URL || ''
const PORT = Number(process.env.PORT || 3000)

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null

// ===============================
// 🔹 Alertas de variáveis
// ===============================
if (!WHATSAPP_TOKEN) console.warn('[WARN] WHATSAPP_TOKEN não configurado.')
if (!PHONE_NUMBER_ID) console.warn('[WARN] PHONE_NUMBER_ID não configurado.')
if (!MOCHA_OCR_URL) console.warn('[WARN] MOCHA_OCR_URL não configurado.')
if (!OPENAI_API_KEY) console.warn('[WARN] OPENAI_API_KEY não definido — OCR desativado.')

const app = new Hono()

// =======================================
// 🔹 Função para enviar mensagem WhatsApp
// =======================================
async function enviarMensagemWhatsApp(to, body) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.error('[ERRO] Faltam variáveis da Meta API.')
    return
  }

  const url = `${GRAPH_API_BASE}/${PHONE_NUMBER_ID}/messages`

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body },
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const data = await resp.json().catch(() => ({}))

  console.log('[WhatsApp][REQUEST]', JSON.stringify(payload, null, 2))
  console.log('[WhatsApp][STATUS]', resp.status)
  console.log('[WhatsApp][RESPONSE]', JSON.stringify(data, null, 2))

  return data
}

// =======================================
// 🔹 IA texto simples (inclui confirmação SIM)
// =======================================
async function responderIA(msg) {
  const t = msg.trim().toUpperCase()

  if (t === 'SIM') {
    return (
      'Perfeito! ✅\n' +
      'O lançamento já foi enviado para o SIGO Obras.\n' +
      'Se algo estiver errado, envie outro comprovante.'
    )
  }

  return `Recebido: ${msg}`
}

// =======================================
// 🔹 Buscar info da mídia
// =======================================
async function buscarInfoMidiaWhatsApp(mediaId) {
  const url = `${GRAPH_API_BASE}/${mediaId}`

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  })

  if (!resp.ok) throw new Error('Falha ao buscar metadados da mídia.')

  return await resp.json()
}

// =======================================
// 🔹 Baixar mídia real
// =======================================
async function baixarMidiaWhatsApp(mediaId) {
  const info = await buscarInfoMidiaWhatsApp(mediaId)

  const resp = await fetch(info.url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  })

  if (!resp.ok) throw new Error('Erro ao baixar mídia.')

  const buffer = Buffer.from(await resp.arrayBuffer())

  return {
    buffer,
    mimeType: info.mime_type,
    fileUrl: info.url,
    fileName: info.id,
  }
}

// =======================================
// 🔹 OCR IMAGEM (OpenAI Vision)
// =======================================
async function processarImagem(buffer, mimeType) {
  if (!openai) throw new Error('OPENAI_API_KEY ausente.')

  const base64 = buffer.toString('base64')
  const dataUrl = `data:${mimeType};base64,${base64}`

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'Retorne APENAS JSON válido: fornecedor, cnpj, valor, data, descricao, texto_completo.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Extraia os dados deste documento:' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  })

  let content = resp.choices[0].message.content
  if (Array.isArray(content)) content = content.map((c) => c.text).join('\n')

  const match = content.match(/\{[\s\S]*\}/)
  try {
    return JSON.parse(match ? match[0] : content)
  } catch {
    return { fornecedor: '', cnpj: '', valor: '', data: '', descricao: '', texto_completo: content }
  }
}

// =======================================
// 🔹 OCR PDF (pdf-parse + OpenAI texto)
// =======================================
async function processarPdf(buffer) {
  if (!openai) throw new Error('OPENAI_API_KEY ausente.')

  const parsed = await pdfParse(buffer)        // << CORREÇÃO AQUI
  const texto = (parsed.text || '').trim()

  if (!texto) return {}

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'Retorne APENAS JSON válido: fornecedor, cnpj, valor, data, descricao, texto_completo.',
      },
      {
        role: 'user',
        content: texto,
      },
    ],
  })

  let content = resp.choices[0].message.content
  if (Array.isArray(content)) content = content.map((c) => c.text).join('\n')

  const match = content.match(/\{[\s\S]*\}/)

  try {
    const json = JSON.parse(match ? match[0] : content)
    return { ...json, texto_completo: texto }
  } catch {
    return { fornecedor: '', cnpj: '', valor: '', data: '', descricao: '', texto_completo: texto }
  }
}

// =======================================
// 🔹 ENVIAR para Mocha (somente após “SIM”)
// =======================================
async function enviarParaMocha(dados) {
  if (!MOCHA_OCR_URL) throw new Error('MOCHA_OCR_URL não configurada.')

  const resp = await fetch(MOCHA_OCR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dados),
  })

  if (!resp.ok) throw new Error(`Mocha retornou ${resp.status}`)

  return await resp.json().catch(() => ({}))
}

// ======================================================
// 🔹 ROTAS
// ======================================================

// TESTE
app.get('/', (c) => c.text('SIGO WHATSAPP BOT OK'))

// WEBHOOK META (GET)
app.get('/webhook/whatsapp', (c) => {
  const mode = c.req.query('hub.mode')
  const token = c.req.query('hub.verify_token')
  const challenge = c.req.query('hub.challenge')

  if (mode === 'subscribe' && token === VERIFY_TOKEN_META) {
    return c.text(challenge)
  }

  return c.text('Erro de validação', 403)
})

// WEBHOOK META (POST)
app.post('/webhook/whatsapp', async (c) => {
  const body = await c.req.json().catch(() => ({}))

  const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
  if (!message) return c.json({ status: 'ignored' })

  const from = message.from
  const type = message.type

  // 👇 TEXTO (inclui SIM)
  if (type === 'text') {
    const txt = message.text.body.trim()

    if (txt.toUpperCase() === 'SIM' && global.lastOCR?.[from]) {
      try {
        await enviarParaMocha(global.lastOCR[from])
        await enviarMensagemWhatsApp(from, 'Lançamento enviado com sucesso! ✅')
      } catch {
        await enviarMensagemWhatsApp(from, 'Erro ao lançar no SIGO Obras.')
      }
      return c.json({ status: 'ok' })
    }

    const resp = await responderIA(txt)
    await enviarMensagemWhatsApp(from, resp)
    return c.json({ status: 'ok' })
  }

  // 👇 DOCUMENTO OU IMAGEM
  if (type === 'document' || type === 'image') {
    try {
      const mediaId =
        type === 'document' ? message.document.id : message.image.id

      const midia = await baixarMidiaWhatsApp(mediaId)

      let dadosExtraidos = {}

      if (midia.mimeType.startsWith('image/')) {
        dadosExtraidos = await processarImagem(midia.buffer, midia.mimeType)
      } else if (midia.mimeType === 'application/pdf') {
        dadosExtraidos = await processarPdf(midia.buffer)
      }

      // Salvar temporariamente no servidor (aguarda SIM)
      global.lastOCR ??= {}
      global.lastOCR[from] = {
        user_phone: from,
        file_url: midia.fileUrl,
        ...dadosExtraidos,
      }

      // Retornar resumo
      await enviarMensagemWhatsApp(
        from,
        `Recebi o documento! 📄\n\nVerifique os dados extraídos:\n` +
          `Fornecedor: ${dadosExtraidos.fornecedor || 'N/D'}\n` +
          `CNPJ: ${dadosExtraidos.cnpj || 'N/D'}\n` +
          `Data: ${dadosExtraidos.data || 'N/D'}\n` +
          `Valor: ${dadosExtraidos.valor || 'N/D'}\n\n` +
          `Se estiver correto, responda *SIM* para lançar no financeiro.`
      )

      return c.json({ status: 'ok' })
    } catch (err) {
      console.error(err)
      await enviarMensagemWhatsApp(
        from,
        'Erro ao processar seu arquivo. Tente outra imagem ou PDF.'
      )
      return c.json({ status: 'error' })
    }
  }

  await enviarMensagemWhatsApp(
    from,
    'Por enquanto só leio texto, imagens e PDFs.'
  )
  return c.json({ status: 'ok' })
})

// =======================================
// 🔹 Servidor
// =======================================
serve({ fetch: app.fetch, port: PORT })
console.log(`🚀 SIGO WHATSAPP BOT rodando na porta ${PORT}`)
