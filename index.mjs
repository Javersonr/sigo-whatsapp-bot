import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import dotenv from 'dotenv'
import OpenAI from 'openai'
import PDFParser from 'pdf2json'

dotenv.config()

// =============== META WHATSAPP API ==================
const GRAPH_API_BASE = 'https://graph.facebook.com/v19.0'

// =============== VARIÁVEIS DE AMBIENTE ===============
const VERIFY_TOKEN_META = process.env.VERIFY_TOKEN_META || 'sinergia123'
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || ''
const PHONE_NUMBER_ID =
  process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID || ''
const MOCHA_OCR_URL = process.env.MOCHA_OCR_URL || ''
const PORT = Number(process.env.PORT || 3000)

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null

console.log('=== VARIÁVEIS DE AMBIENTE ===')
console.log('VERIFY_TOKEN_META:', VERIFY_TOKEN_META ? 'OK' : 'VAZIO')
console.log('WHATSAPP_TOKEN:', WHATSAPP_TOKEN ? 'OK' : 'VAZIO')
console.log('PHONE_NUMBER_ID:', PHONE_NUMBER_ID || 'VAZIO')
console.log('MOCHA_OCR_URL:', MOCHA_OCR_URL || 'VAZIO')
console.log('OPENAI_API_KEY:', OPENAI_API_KEY ? 'OK' : 'VAZIO')
console.log('==============================')

const app = new Hono()

// =====================================================
// 🔹 Extrair TEXTO de PDF usando pdf2json
// =====================================================
async function extrairTextoPDF(buffer) {
  return new Promise((resolve, reject) => {
    try {
      const pdfParser = new PDFParser()

      pdfParser.on('pdfParser_dataError', (errData) => {
        console.error('[PDF] Erro no parser:', errData.parserError)
        reject(errData.parserError)
      })

      pdfParser.on('pdfParser_dataReady', () => {
        const text = pdfParser.getRawTextContent() || ''
        console.log('[PDF] Texto extraído (primeiros 300 chars):', text.slice(0, 300))
        resolve(text)
      })

      pdfParser.parseBuffer(buffer)
    } catch (err) {
      console.error('[PDF] Erro geral ao tentar ler PDF:', err)
      reject(err)
    }
  })
}

// =====================================================
// 🔹 Enviar mensagem WhatsApp
// =====================================================
async function enviarMensagemWhatsApp(to, body) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.error('[ERRO] WHATSAPP_TOKEN ou PHONE_NUMBER_ID não configurados.')
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

  return data
}

// =====================================================
// 🔹 Buscar dados da mídia
// =====================================================
async function buscarInfoMidia(mediaId) {
  const url = `${GRAPH_API_BASE}/${mediaId}`

  console.log('[WhatsApp][MEDIA INFO][GET]', url)

  const resp = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  })

  if (!resp.ok) {
    console.error('[WhatsApp][MEDIA INFO] Erro status:', resp.status)
    throw new Error('Erro ao buscar metadados da mídia')
  }

  const data = await resp.json()
  console.log('[WhatsApp][MEDIA INFO][RESPONSE]', JSON.stringify(data, null, 2))
  return data
}

// =====================================================
// 🔹 Baixar arquivo da mídia
// =====================================================
async function baixarMidia(mediaId) {
  const meta = await buscarInfoMidia(mediaId)

  const resp = await fetch(meta.url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  })

  if (!resp.ok) {
    console.error('[WhatsApp][MEDIA DOWNLOAD] Erro status:', resp.status)
    throw new Error('Erro ao baixar mídia')
  }

  const buffer = Buffer.from(await resp.arrayBuffer())

  console.log('[WhatsApp][MEDIA DOWNLOAD] mime_type=', meta.mime_type)

  return {
    buffer,
    mimeType: meta.mime_type || 'application/octet-stream',
    fileUrl: meta.url,
  }
}

// =====================================================
// 🔹 OCR IMAGEM VIA OPENAI
// =====================================================
async function ocrImagem(buffer, mimeType) {
  if (!openai) {
    console.error('[OCR IMAGEM] OPENAI_API_KEY ausente.')
    return {}
  }

  const base64 = buffer.toString('base64')

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'Você é um extrator de informações de comprovantes. ' +
          'Retorne APENAS JSON válido com: fornecedor, cnpj, valor, data, descricao, texto_completo.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Extraia os dados deste comprovante/nota:' },
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${base64}` },
          },
        ],
      },
    ],
  })

  console.log('[OCR IMAGEM][RAW MESSAGE]', resp.choices[0].message)

  let content = resp.choices[0].message.content
  if (Array.isArray(content)) {
    content = content.map((c) => c.text || '').join('\n')
  }

  const match = content.match(/\{[\s\S]*\}/)

  try {
    const json = JSON.parse(match ? match[0] : content)
    return json
  } catch (e) {
    console.error('[OCR IMAGEM] Erro ao parsear JSON:', e)
    return {
      fornecedor: '',
      cnpj: '',
      valor: '',
      data: '',
      descricao: '',
      texto_completo: content,
    }
  }
}

// =====================================================
// 🔹 OCR PDF (extrai texto + IA)
// =====================================================
async function ocrPdf(buffer) {
  if (!openai) {
    console.error('[OCR PDF] OPENAI_API_KEY ausente.')
    return {}
  }

  let texto = ''
  try {
    texto = await extrairTextoPDF(buffer)
  } catch (e) {
    console.error('[OCR PDF] Erro ao extrair texto do PDF:', e)
    return {
      fornecedor: '',
      cnpj: '',
      valor: '',
      data: '',
      descricao: '',
      texto_completo: '',
    }
  }

  if (!texto.trim()) {
    console.warn('[OCR PDF] Texto extraído vazio.')
    return {
      fornecedor: '',
      cnpj: '',
      valor: '',
      data: '',
      descricao: '',
      texto_completo: '',
    }
  }

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'Você é um extrator de informações de comprovantes, boletos e notas. ' +
          'Retorne APENAS JSON válido com: fornecedor, cnpj, valor, data, descricao, texto_completo.',
      },
      {
        role: 'user',
        content:
          'Segue o texto de um documento, extraia os dados estruturados e responda somente o JSON:\n\n' +
          texto,
      },
    ],
  })

  console.log('[OCR PDF][RAW MESSAGE]', resp.choices[0].message)

  let content = resp.choices[0].message.content
  if (Array.isArray(content)) {
    content = content.map((c) => c.text || '').join('\n')
  }

  const match = content.match(/\{[\s\S]*\}/)

  try {
    const json = JSON.parse(match ? match[0] : content)
    return {
      ...json,
      texto_completo: texto,
    }
  } catch (e) {
    console.error('[OCR PDF] Erro ao parsear JSON:', e)
    return {
      fornecedor: '',
      cnpj: '',
      valor: '',
      data: '',
      descricao: '',
      texto_completo: texto,
    }
  }
}

// =====================================================
// 🔹 WEBHOOK GET (Verificação)
// =====================================================
app.get('/webhook/whatsapp', (c) => {
  const mode = c.req.query('hub.mode')
  const token = c.req.query('hub.verify_token')
  const challenge = c.req.query('hub.challenge')

  console.log('[Webhook GET] mode=', mode, ' token=', token, ' challenge=', challenge)

  if (mode === 'subscribe' && token === VERIFY_TOKEN_META) {
    console.log('[Webhook GET] Verificação OK')
    return c.text(challenge || '')
  }

  console.warn('[Webhook GET] Falha na verificação do webhook')
  return c.text('Erro validação', 403)
})

// =====================================================
// 🔹 WEBHOOK POST (Mensagens)
// =====================================================
app.post('/webhook/whatsapp', async (c) => {
  const body = await c.req.json().catch(() => ({}))

  console.log('[Webhook POST] BODY RECEBIDO:')
  console.log(JSON.stringify(body, null, 2))

  const value = body.entry?.[0]?.changes?.[0]?.value
  const message = value?.messages?.[0]

  if (!message) {
    console.log('[Webhook POST] Nenhuma mensagem encontrada, ignorando.')
    return c.json({ status: 'ignored' })
  }

  const from = message.from
  const type = message.type

  console.log(`[Mensagem de ${from}] type=${type}`)

  // ================= TEXTO ========================
  if (type === 'text') {
    const texto = message.text?.body?.trim() || ''
    const upper = texto.toUpperCase()

    console.log(`[Texto recebido] "${texto}"`)

    // CONFIRMAÇÃO SIM -> envia o último OCR salvo pro Mocha
    if (upper === 'SIM' && global.lastData?.[from]) {
      console.log('[CONFIRMAÇÃO SIM] Enviando dados ao Mocha...', global.lastData[from])
      try {
        if (!MOCHA_OCR_URL) {
          console.error('[MOCHA OCR] MOCHA_OCR_URL não configurado.')
          await enviarMensagemWhatsApp(
            from,
            'Erro na integração com o SIGO Obras (URL não configurada).'
          )
        } else {
          const respMocha = await fetch(MOCHA_OCR_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(global.lastData[from]),
          })

          let dataMocha = {}
          try {
            dataMocha = await respMocha.json()
          } catch {
            dataMocha = {}
          }

          console.log('[MOCHA OCR][STATUS]', respMocha.status)
          console.log('[MOCHA OCR][RESPONSE]', JSON.stringify(dataMocha, null, 2))

          if (respMocha.ok) {
            await enviarMensagemWhatsApp(
              from,
              'Perfeito! ✅\nO lançamento foi enviado para o SIGO Obras.\nSe algo estiver errado, envie outro comprovante.'
            )
          } else {
            await enviarMensagemWhatsApp(
              from,
              'Ocorreu um erro ao lançar no SIGO Obras. Tente novamente mais tarde.'
            )
          }
        }
      } catch (e) {
        console.error('[MOCHA OCR] Erro ao enviar para SIGO Obras:', e)
        await enviarMensagemWhatsApp(
          from,
          'Erro ao enviar os dados para o SIGO Obras. Tente novamente mais tarde.'
        )
      }

      return c.json({ status: 'ok' })
    }

    // Texto normal
    await enviarMensagemWhatsApp(from, `Recebido: ${texto}`)
    return c.json({ status: 'ok' })
  }

  // ================ ARQUIVOS (PDF/IMAGEM) ======================
  if (type === 'document' || type === 'image') {
    try {
      let mediaId = null
      let mimeType = 'application/octet-stream'

      if (type === 'document') {
        mediaId = message.document?.id
        mimeType = message.document?.mime_type || mimeType
      } else if (type === 'image') {
        mediaId = message.image?.id
        mimeType = message.image?.mime_type || mimeType
      }

      if (!mediaId) {
        console.error('[ERRO] Nenhum mediaId encontrado na mensagem.')
        await enviarMensagemWhatsApp(
          from,
          'Não consegui identificar o arquivo enviado. Tente reenviar o documento ou imagem.'
        )
        return c.json({ status: 'ok' })
      }

      console.log(`[Arquivo recebido de ${from}] mediaId=${mediaId} mimeType=${mimeType}`)

      const midia = await baixarMidia(mediaId)

      let dados = {
        fornecedor: '',
        cnpj: '',
        valor: '',
        data: '',
        descricao: '',
        texto_completo: '',
      }

      if (midia.mimeType === 'application/pdf') {
        console.log('[OCR] Processando como PDF...')
        dados = await ocrPdf(midia.buffer)
      } else if (midia.mimeType.startsWith('image/')) {
        console.log('[OCR] Processando como IMAGEM...')
        dados = await ocrImagem(midia.buffer, midia.mimeType)
      } else {
        console.warn('[OCR] Tipo de arquivo não suportado para OCR automático:', midia.mimeType)
      }

      console.log('[OCR] Dados extraídos:', dados)

      // Guarda para confirmação SIM depois
      global.lastData ??= {}
      global.lastData[from] = {
        user_phone: from,
        file_url: midia.fileUrl,
        fornecedor: dados.fornecedor || '',
        cnpj: dados.cnpj || '',
        valor: dados.valor || '',
        data: dados.data || '',
        descricao: dados.descricao || '',
        texto_ocr: dados.texto_completo || '',
      }

      const fornecedor = dados.fornecedor || 'N/D'
      const cnpj = dados.cnpj || 'N/D'
      const dataDoc = dados.data || 'N/D'
      const valor = dados.valor || 'N/D'
      const descricao = dados.descricao || 'N/D'

      const msgResumo =
        `Recebi o seu comprovante ✅\n\n` +
        `Fornecedor: ${fornecedor}\n` +
        `CNPJ: ${cnpj}\n` +
        `Data: ${dataDoc}\n` +
        `Valor: ${valor}\n` +
        `Descrição: ${descricao}\n\n` +
        `Se estiver correto, responda *SIM* para lançar no financeiro.`

      await enviarMensagemWhatsApp(from, msgResumo)

      return c.json({ status: 'ok' })
    } catch (e) {
      console.error('[ERRO AO PROCESSAR DOCUMENTO/IMAGEM]', e)

      await enviarMensagemWhatsApp(
        from,
        'Erro ao processar seu arquivo 📄🖼️\n\n' +
          'Tente enviar outra imagem mais nítida (sem cortes e com boa iluminação),\n' +
          'ou, se possível, envie o comprovante em PDF diretamente.'
      )

      return c.json({ status: 'error' })
    }
  }

  console.log('[Webhook POST] Tipo não tratado:', type)
  await enviarMensagemWhatsApp(
    from,
    'Por enquanto, só consigo ler texto, imagens e PDFs.'
  )
  return c.json({ status: 'ok' })
})

// =====================================================
// 🔹 ROTA TESTE
// =====================================================
app.get('/', (c) => c.text('SIGO WHATSAPP BOT OK'))

// =====================================================
// 🔹 INICIAR SERVIDOR
// =====================================================
serve({ fetch: app.fetch, port: PORT })
console.log(`🚀 SIGO WHATSAPP BOT rodando na porta ${PORT}`)
