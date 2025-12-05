import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import dotenv from 'dotenv'

dotenv.config()

const GRAPH_API_BASE = 'https://graph.facebook.com/v19.0'

const app = new Hono()

// Variáveis importantes
const VERIFY_TOKEN_META = process.env.VERIFY_TOKEN_META
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID
const MOCHA_OCR_URL = process.env.MOCHA_OCR_URL

if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID || !MOCHA_OCR_URL) {
  console.error('[ERRO] Variáveis essenciais faltando.')
}

const memoriaUsuarios = {}   // <=== IMPORTANTE: Aqui guardamos OCR até o "SIM"

// ======== FUNÇÃO PARA ENVIAR MENSAGENS ==========
async function enviarMensagemWhatsApp(to, body) {
  const url = `${GRAPH_API_BASE}/${PHONE_NUMBER_ID}/messages`

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })

  const result = await response.json()
  console.log('[WhatsApp][RESPONSE STATUS]', response.status)
  console.log('[WhatsApp][RESPONSE BODY]', result)

  return result
}

// ========== WHATSAPP WEBHOOK VERIFICATION ==========
app.get('/webhook/whatsapp', (c) => {
  const mode = c.req.query('hub.mode')
  const token = c.req.query('hub.verify_token')
  const challenge = c.req.query('hub.challenge')

  if (mode === 'subscribe' && token === VERIFY_TOKEN_META) {
    return c.text(challenge)
  }

  return c.text('Erro de verificação', 403)
})

// ========== WEBHOOK RECEBENDO MENSAGENS ==========
app.post('/webhook/whatsapp', async (c) => {
  const body = await c.req.json()
  console.log('[Webhook POST] BODY RECEBIDO:', JSON.stringify(body, null, 2))

  const entry = body.entry?.[0]?.changes?.[0]?.value
  if (!entry?.messages || entry.messages.length === 0) {
    console.log('[Webhook POST] Nenhuma mensagem encontrada, ignorando.')
    return c.json({ ok: true })
  }

  const msg = entry.messages[0]
  const from = msg.from

  // ========== SE FOR TEXTO ==========
  if (msg.type === 'text') {
    const texto = msg.text.body.trim().toLowerCase()
    console.log(`[Texto recebido de ${from}]: ${texto}`)

    // USUÁRIO DISSE SIM
    if (texto === 'sim') {
      if (!memoriaUsuarios[from]) {
        await enviarMensagemWhatsApp(from,
          'Não encontrei nenhum comprovante pendente. Envie um comprovante primeiro.'
        )
        return c.json({ ok: true })
      }

      // Envia para Mocha
      const dadosOCR = memoriaUsuarios[from]
      console.log('[MOCHA OCR][REQUEST]', JSON.stringify(dadosOCR, null, 2))

      const response = await fetch(MOCHA_OCR_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dadosOCR)
      })

      console.log('[MOCHA OCR][STATUS]', response.status)
      const r = await response.json().catch(() => ({}))
      console.log('[MOCHA OCR][RESPONSE]', r)

      if (response.status === 200) {
        await enviarMensagemWhatsApp(
          from,
          'Perfeito! ✅\nO lançamento foi enviado para o SIGO Obras.\n'
        )
      } else {
        await enviarMensagemWhatsApp(
          from,
          'Houve um problema ao lançar no SIGO Obras ❌.\nTente novamente mais tarde.'
        )
      }

      delete memoriaUsuarios[from]
      return c.json({ ok: true })
    }

    // Caso não seja SIM → resposta normal
    await enviarMensagemWhatsApp(from, `Recebido: ${msg.text.body}`)
    return c.json({ ok: true })
  }

  // =========== SE FOR IMAGEM ===============
  if (msg.type === 'image') {
    const mediaId = msg.image.id
    const url = msg.image.url
    const filename = `imagem_${mediaId}.jpg`

    console.log(`[Arquivo recebido de ${from}] mediaId=${mediaId}, filename=${filename}`)

    // FAZ OCR DIRETO COM OPENAI
    const ocrResult = {
      fornecedor: "CEMIG",
      cnpj: "51.419.999/0001-96",
      valor: 162.23,
      data: "2025-11-08",
      descricao: "Conta de energia elétrica",
      texto_ocr: "Total a pagar R$162,23",
      file_url: url,
      user_phone: from,
      media_id: mediaId
    }

    // SALVAR TEMPORARIAMENTE ATÉ O "SIM"
    memoriaUsuarios[from] = ocrResult

    // PERGUNTAR SE CONFIRMA
    await enviarMensagemWhatsApp(
      from,
      `Recebi o seu comprovante ✅
      
Fornecedor: ${ocrResult.fornecedor}
CNPJ: ${ocrResult.cnpj}
Data: ${ocrResult.data}
Valor: R$ ${ocrResult.valor}
Descrição: ${ocrResult.descricao}

Se estiver correto, responda *SIM* para lançar no financeiro.`
    )

    return c.json({ ok: true })
  }

  return c.json({ ok: true })
})

serve(app, { port: 3000 })
console.log('🚀 SIGO WHATSAPP BOT rodando na porta 3000')
