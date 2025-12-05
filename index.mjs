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

/**
 * 🔹 Busca URL da mídia no Graph API a partir do media_id
 * e chama o endpoint de OCR no Mocha.
 *
 * 1) GET no Graph: /{media-id}?fields=url,mime_type
 * 2) POST no Mocha: /api/ocr-upload (file_url, file_type)
 */
async function chamarOcrMochaComMediaId(mediaId, mimeTypeOriginal) {
  if (!WHATSAPP_TOKEN) {
    throw new Error('WHATSAPP_TOKEN não configurado')
  }

  console.log('OCR - Buscando URL da mídia no Graph. media_id:', mediaId)

  const mediaRes = await fetch(
    `${GRAPH_API_BASE}/${mediaId}?fields=url,mime_type`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        Accept: 'application/json'
      }
    }
  )

  if (!mediaRes.ok) {
    const erroTexto = await mediaRes.text()
    console.error('OCR - Erro ao buscar mídia no Graph:', mediaRes.status, erroTexto)
    throw new Error(`Falha ao obter mídia do Graph: ${mediaRes.status}`)
  }

  const mediaJson = await mediaRes.json()
  console.log('OCR - Retorno mídia Graph:', mediaJson)

  const fileUrl = mediaJson.url
  const mimeType = mimeTypeOriginal || mediaJson.mime_type || 'image/jpeg'

  if (!fileUrl) {
    throw new Error('URL da mídia não encontrada no retorno do Graph')
  }

  const fileType = mimeType === 'application/pdf' ? 'pdf' : 'image'

  console.log('OCR - Enviando para Mocha:', {
    file_url: fileUrl,
    file_type: fileType
  })

  const ocrRes = await fetch('https://sigoobras2.mocha.app/api/ocr-upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
      // Se tiver auth no Mocha, adicionar aqui:
      // 'x-api-key': process.env.MOCHA_OCR_TOKEN || ''
    },
    body: JSON.stringify({
      file_url: fileUrl,
      file_type: fileType
    })
  })

  const ocrBodyText = await ocrRes.text()
  let ocrJson = null

  try {
    ocrJson = JSON.parse(ocrBodyText)
  } catch (e) {
    console.error('OCR - Resposta do Mocha não é JSON válido:', ocrBodyText)
    throw new Error('Resposta do Mocha não é JSON válido')
  }

  if (!ocrRes.ok) {
    console.error('OCR - Mocha respondeu erro:', ocrRes.status, ocrJson)
    throw new Error(`Mocha retornou erro: ${ocrRes.status}`)
  }

  console.log('OCR - Mocha resposta OK:', ocrJson)
  return ocrJson
}

/**
 * 🔹 Monta texto amigável para o usuário a partir do JSON do OCR
 */
function montarTextoRespostaOcr(ocrJson) {
  // Ajuste os campos conforme o que seu endpoint de OCR está devolvendo
  const fornecedor = ocrJson.fornecedor || ocrJson.supplier || 'não identificado'
  const cnpj = ocrJson.cnpj || 'não identificado'
  const dataDoc = ocrJson.data || ocrJson.data_documento || 'não identificada'
  const valorTotal = ocrJson.valor_total || ocrJson.total || 'não identificado'

  let itensResumo = ''

  if (Array.isArray(ocrJson.itens || ocrJson.items)) {
    const itens = ocrJson.itens || ocrJson.items
    const primeiros = itens.slice(0, 3)
    itensResumo =
      '\n\nItens (parcial):\n' +
      primeiros
        .map((it, idx) => {
          const desc = it.descricao || it.description || 'Item sem descrição'
          const qnt = it.quantidade || it.qty || it.qtd || 1
          const vlr = it.valor_total || it.total || it.valor || ''
          return `${idx + 1}. ${desc} - Qtde: ${qnt} - Vlr: ${vlr}`
        })
        .join('\n')
  }

  const msg =
    `✅ Leitura concluída!\n\n` +
    `Fornecedor: ${fornecedor}\n` +
    `CNPJ: ${cnpj}\n` +
    `Data: ${dataDoc}\n` +
    `Valor total: ${valorTotal}` +
    itensResumo

  return msg
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

    // 🔸 TEXTO
    if (tipo === 'text') {
      const texto = message.text?.body || ''
      console.log('WA - TEXTO RECEBIDO:', texto)

      textoResposta = await responderIA(texto)
    }

    // 🔸 IMAGEM / FOTO → chama OCR no Mocha
    else if (tipo === 'image') {
      const mediaId = message.image?.id
      const caption = message.image?.caption || ''
      const mimeType = message.image?.mime_type || 'image/jpeg'

      console.log('WA - IMAGEM RECEBIDA. media_id:', mediaId, 'caption:', caption, 'mimeType:', mimeType)

      try {
        const ocrJson = await chamarOcrMochaComMediaId(mediaId, mimeType)
        textoResposta = montarTextoRespostaOcr(ocrJson)
      } catch (e) {
        console.error('WA - Erro ao processar imagem com OCR:', e)
        textoResposta = '📷 Recebi sua foto, mas não consegui ler os dados. Tente enviar uma foto mais nítida ou em melhor iluminação.'
      }
    }

    // 🔸 DOCUMENTO (PDF, etc.) → chama OCR no Mocha
    else if (tipo === 'document') {
      const mediaId = message.document?.id
      const filename = message.document?.filename || ''
      const mimeType = message.document?.mime_type || 'application/pdf'

      console.log(
        'WA - DOCUMENTO RECEBIDO. media_id:',
        mediaId,
        'filename:',
        filename,
        'mime_type:',
        mimeType
      )

      try {
        const ocrJson = await chamarOcrMochaComMediaId(mediaId, mimeType)
        textoResposta = montarTextoRespostaOcr(ocrJson)
      } catch (e) {
        console.error('WA - Erro ao processar documento com OCR:', e)
        textoResposta = '📄 Recebi seu arquivo, mas não consegui ler os dados. Se possível, envie em PDF bem nítido.'
      }
    }

    // 🔸 Outros tipos (áudio, vídeo, etc.)
    else {
      console.log('WA - Tipo de mensagem não tratado ainda:', tipo)
      textoResposta = `Recebi uma mensagem do tipo: ${tipo}. Em breve vou saber tratar isso. 😉`
    }

    // 🔹 Envio da resposta para o WhatsApp
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
