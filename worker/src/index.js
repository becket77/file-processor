import { WorkflowEntrypoint, Container } from 'cloudflare:workers';

// ── Контейнер ────────────────────────────────────────────

export class ReportContainer extends Container {
  defaultPort = 8000;
  sleepAfter = '5 minutes';
}

// ── Вспомогательные функции ──────────────────────────────

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function getToken(env) {
  const response = await fetch(env.TOKEN_SERVICE_URL);
  if (!response.ok) throw new Error(`Token service error: ${response.status}`);
  const data = await response.json();
  return data.tkn;
}

function getContainer(env, id) {
  return env.REPORT_CONTAINER.get(
    env.REPORT_CONTAINER.idFromName(id)
  );
}

// ── Workflow ─────────────────────────────────────────────

export class ReportWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { jobId, codesKey, email } = event.payload;

    // Шаг 1 — загрузить коды из R2
    const codes = await step.do('load-codes', async () => {
      const obj = await this.env.FILES.get(codesKey);
      const text = await obj.text();
      return JSON.parse(text);
    });

    await this.env.JOBS.put(`status/${jobId}`, JSON.stringify({
      status: 'processing',
      totalCodes: codes.length,
      processedCodes: 0,
      startedAt: Date.now()
    }));

    // Шаг 2 — запросы к CRPT API пачками по 1000
    const chunks = chunkArray(codes, 1000);
    const allItems = [];

    for (let i = 0; i < chunks.length; i++) {
      const result = await step.do(`api-batch-${i}`, {
        retries: { limit: 3, delay: '15 seconds', backoff: 'linear' }
      }, async () => {
        const token = await getToken(this.env);

        const response = await fetch(this.env.EXTERNAL_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify(chunks[i])
        });

        if (!response.ok) {
          throw new Error(`CRPT API error: ${response.status}`);
        }

        return response.json();
      });

      // CRPT возвращает массив объектов
      const normalized = result.map(item => ({
  		requestedCis: item.cisInfo?.requestedCis || '',
  		status:        item.cisInfo?.status || 'NOT_FOUND',
  		ownerName:     item.cisInfo?.ownerName || null,
  		productName:   item.cisInfo?.productName || null,
  		brand:         item.cisInfo?.brand || null,
  		emissionDate:  item.cisInfo?.emissionDate || null,
  		producedDate:  item.cisInfo?.producedDate || null,
  		expirationDate:item.cisInfo?.expirationDate || null,
  		tnVedEaes:     item.cisInfo?.tnVedEaes || null,
  		productGroup:  item.cisInfo?.productGroup || null,
  		errorCode:     item.errorCode || null,
  		errorMessage:  item.errorMessage || null,
	  }));
	  allItems.push(...normalized);

      // Обновить прогресс в KV
      await this.env.JOBS.put(`status/${jobId}`, JSON.stringify({
        status: 'processing',
        totalCodes: codes.length,
        processedCodes: Math.min((i + 1) * 1000, codes.length),
        startedAt: Date.now()
      }));

      // Rate limit — 150ms между пачками
      if (i < chunks.length - 1) {
        await step.sleep(`pause-${i}`, '150 milliseconds');
      }
    }

    // Шаг 3 — сгенерировать отчёт и PDF через контейнер
    const reportResult = await step.do('generate-report', {
      retries: { limit: 2, delay: '10 seconds' }
    }, async () => {
      const container = getContainer(this.env, jobId);

      const response = await container.fetch('http://container/generate-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, items: allItems, email })
      });

      if (!response.ok) throw new Error(`Report generation error: ${response.status}`);
      return response.json();
    });

    // Финальный статус
    await this.env.JOBS.put(`status/${jobId}`, JSON.stringify({
      status: 'done',
      totalCodes: codes.length,
      processedCodes: codes.length,
      pdfKey: reportResult.pdfKey,
      summary: reportResult.summary,
      finishedAt: Date.now()
    }));

    return reportResult;
  }
}

// ── Worker API ───────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // POST /api/upload — загрузка и парсинг файла
    if (url.pathname === '/api/upload' && request.method === 'POST') {
      try {
        const formData = await request.formData();
        const file  = formData.get('file');
        const email = formData.get('email') || null;

        if (!file) return json({ error: 'No file provided' }, 400);

        const jobId = crypto.randomUUID();

        // Парсинг файла в контейнере
        const container = getContainer(env, `parse-${jobId}`);
        const parseForm = new FormData();
        parseForm.append('file', file);
        parseForm.append('jobId', jobId);

        const parseResp = await container.fetch('http://container/parse', {
          method: 'POST',
          body: parseForm
        });

        if (!parseResp.ok) {
          const err = await parseResp.json();
          return json({ error: err.error || 'Parse error' }, 400);
        }

        const { codesKey, count } = await parseResp.json();

        // Начальный статус
        await env.JOBS.put(`status/${jobId}`, JSON.stringify({
          status: 'processing',
          totalCodes: count,
          processedCodes: 0,
          startedAt: Date.now()
        }));

        // Запустить Workflow
        await env.REPORT_WORKFLOW.create({
          id: jobId,
          params: { jobId, codesKey, email }
        });

        return json({ jobId, totalCodes: count });

      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // GET /api/status/:jobId — прогресс обработки
    if (url.pathname.startsWith('/api/status/')) {
      const jobId = url.pathname.split('/').pop();
      const raw = await env.JOBS.get(`status/${jobId}`);
      if (!raw) return json({ error: 'Job not found' }, 404);
      return json(JSON.parse(raw));
    }

    // GET /api/report/:jobId — скачать PDF
    if (url.pathname.startsWith('/api/report/')) {
      const jobId = url.pathname.split('/').pop();
      const raw = await env.JOBS.get(`status/${jobId}`);
      if (!raw) return json({ error: 'Job not found' }, 404);

      const status = JSON.parse(raw);
      if (status.status !== 'done') return json({ error: 'Not ready yet' }, 202);

      const pdf = await env.FILES.get(status.pdfKey);
      if (!pdf) return json({ error: 'PDF not found' }, 404);

      return new Response(pdf.body, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="report-${jobId}.pdf"`,
          ...CORS
        }
      });
    }

    return json({ error: 'Not found' }, 404);
  }
};
