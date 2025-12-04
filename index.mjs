import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import dotenv from 'dotenv'

dotenv.config()

const GRAPH_API_BASE = 'https://graph.facebook.com/v19.0'

const app = new Hono()

// 🔹 Variáveis de ambiente
const VERIFY_TOKEN_META = process.env.VERIFY_TOKEN_META || 'sinergia123'
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || ''
const PORT = Number(process.env.PORT || 3000)

// 🔹 Função central de resposta (IA, menus, etc.)
// por enquanto só ecoa o texto
async function responderIA(texto) {
  return `Recebido: ${texto}`
}

// 🔹 Rota raiz só pra testar se o servidor está online
app.get('/', (c) => {
  return c.text('SIGO BOT OK')
})

// 🔹 Verificação de webhook (GET)
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

// 🔹 Recebimento de mensagens (POST)
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
    const metadataPhoneId = value.metadata?.phone_number_id // id do número do bot
    const waId = metadataPhoneId

    console.log('WA - FROM:', from)
    console.log('WA - PHONE_NUMBER_ID (metadata):', metadataPhoneId)

    if (!WHATSAPP_TOKEN || !waId) {
      console.error('WA - WHATSAPP_TOKEN ou phone_number_id ausente')
      return c.json({ status: 'erro_token_ou_phone_id' }, 500)
    }

    const tipo = message.type
    console.log('WA - TIPO DE MENSAGEM:', tipo)

    let textoResposta = ''
    let textoLogExtra = ''

    // 🔸 TEXTO
    if (tipo === 'text') {
      const texto = message.text?.body || ''
      console.log('WA - TEXTO RECEBIDO:', texto)

      textoResposta = await responderIA(texto)
    }

    // 🔸 IMAGEM / FOTO
    else if (tipo === 'image') {
      const mediaId = message.image?.id
      const caption = message.image?.caption || ''

      console.log('WA - IMAGEM RECEBIDA. media_id:', mediaId, 'caption:', caption)

      textoResposta = '📷 Recebi sua foto, vou processar.'
      textoLogExtra = `IMAGEM media_id=${mediaId} caption="${caption}"`
    }

    // 🔸 DOCUMENTO (PDF, etc.)
    else if (tipo === 'document') {
      const mediaId = message.document?.id
      const filename = message.document?.filename || ''
      const mimeType = message.document?.mime_type || ''

      console.log(
        'WA - DOCUMENTO RECEBIDO. media_id:',
        mediaId,
        'filename:',
        filename,
        'mime_type:',
        mimeType
      )

      textoResposta = '📄 Recebi seu arquivo, vou processar.'
      textoLogExtra = `DOCUMENTO media_id=${mediaId} filename="${filename}" mime="${mimeType}"`
    }

    // 🔸 Outros tipos (áudio, vídeo, etc.) – por enquanto só loga
    else {
      console.log('WA - Tipo de mensagem não tratado ainda:', tipo)
      textoResposta = `Recebi uma mensagem do tipo: ${tipo}. Em breve vou saber tratar isso. 😉`
    }

    if (textoLogExtra) {
      console.log('WA - INFO EXTRA:', textoLogExtra)
    }

    // 🔹 Envio da resposta de volta pelo WhatsApp
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
        text: { body: textoResposta }
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
  } catch (err) {
    console.error('WA - Erro no handler do webhook:', err)
    return c.json({ status: 'erro', detalhe: String(err) }, 500)
  }
})

console.log(`Iniciando servidor em http://localhost:${PORT} ...`)
serve({ fetch: app.fetch, port: PORT })
