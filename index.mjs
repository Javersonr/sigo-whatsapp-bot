import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import dotenv from 'dotenv'

dotenv.config()

const GRAPH_API_BASE = 'https://graph.facebook.com/v19.0'

const app = new Hono()

// 🔹 Variáveis de ambiente
const VERIFY_TOKEN_META = process.env.VERIFY_TOKEN_META || 'sinergia123'
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || ''
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || ''
const PORT = Number(process.env.PORT || 3000)

// 🔹 Função central de resposta (aqui depois você coloca IA/Mocha/etc.)
async function responderIA(texto) {
  return `Recebido: ${texto}`
}

// 🔹 Rota raiz só pra testar se o servidor está online
app.get('/', (c) => {
  return c.text('SIGO BOT OK')
})

// 🔹 Rota usada pela Meta para VALIDAR o webhook (modo subscribe)
app.get('/webhook/whatsapp', (c) => {
  console.log('GET /webhook/whatsapp', c.req.raw.url)

  const mode = c.req.query('hub.mode')
  const token = c.req.query('hub.verify_token')
  const challenge = c.req.query('hub.challenge')

  if (mode === 'subscribe' && token === VERIFY_TOKEN_META) {
    return c.text(challenge ?? '')
  }

  return c.text('Erro de verificação', 403)
})

// 🔹 Rota que recebe as mensagens do WhatsApp
app.post('/webhook/whatsapp', async (c) => {
  const body = await c.req.json()
  console.log('POST /webhook/whatsapp', JSON.stringify(body, null, 2))

  try {
    const entry = body.entry?.[0]
    const changes = entry?.changes?.[0]
    const value = changes?.value
    const message = value?.messages?.[0]

    if (!message) {
      console.log('Nenhuma mensagem encontrada no payload')
      return c.json({ status: 'sem_mensagem' })
    }

    const from = message.from // número do cliente
    const metadataPhoneId = value.metadata?.phone_number_id // id do número do bot vindo do webhook
    const waId = WHATSAPP_PHONE_NUMBER_ID || metadataPhoneId

    if (message.type === 'text') {
      const texto = message.text?.body || ''

      console.log('WA - MENSAGEM RECEBIDA DE:', from, 'TEXTO:', texto)
      console.log('WA - PHONE_NUMBER_ID (metadata):', metadataPhoneId)
      console.log('WA - PHONE_NUMBER_ID (usado):', waId)
      console.log('WA - WHATSAPP_TOKEN está definido?', !!WHATSAPP_TOKEN)

      if (!WHATSAPP_TOKEN || !waId) {
        console.error('WA - WHATSAPP_TOKEN ou phone_number_id ausente')
        return c.json({ status: 'erro_token_ou_phone_id' }, 500)
      }

      const respostaTextoIA = await responderIA(texto)

      const url = `${GRAPH_API_BASE}/${waId}/messages`
      console.log('WA - Enviando mensagem para URL:', url)

      const resposta = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: from,
          type: 'text',
          text: { body: respostaTextoIA }
        })
      })

      const contentType = resposta.headers.get('content-type')
      const respostaTexto = await resposta.text()

      console.log('WA - RESPOSTA DA META - status:', resposta.status)
      console.log('WA - Content-Type:', contentType)
      console.log('WA - Body (primeiros 300 chars):', respostaTexto.slice(0, 300))

      if (!resposta.ok) {
        console.error('WA - Falha ao enviar mensagem para WhatsApp')
        return c.json(
          {
            status: 'erro_envio_whatsapp',
            httpStatus: resposta.status,
            detalhe: respostaTexto
          },
          500
        )
      }

      return c.json({ status: 'respondido' })
    }

    console.log('WA - Tipo de mensagem não tratado:', message.type)
    return c.json({ status: 'tipo_nao_tratado', tipo: message.type })
  } catch (err) {
    console.error('WA - Erro no handler do webhook:', err)
    return c.json({ status: 'erro', detalhe: String(err) }, 500)
  }
})

console.log(`Iniciando servidor em http://localhost:${PORT} ...`)
serve({ fetch: app.fetch, port: PORT })
