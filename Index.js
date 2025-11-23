// index.js - VeoMaker backend (Node.js + Express)
// WARNING: This is a starter implementation. Read the README for deployment notes.
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const AWS = require('aws-sdk');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const PUBLIC_TOKEN = process.env.BACKEND_PUBLIC_TOKEN || 'veomaker-public-token-12345';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;
const CALLBACK_URL = process.env.CALLBACK_URL || null;
const STORAGE_PROVIDER = (process.env.STORAGE_PROVIDER || 'local').toLowerCase(); // 's3' or 'local'
const LOCAL_STORAGE_DIR = process.env.LOCAL_STORAGE_DIR || './storage';
const S3_BUCKET = process.env.S3_BUCKET || '';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// In-memory job store (simple). For production use a DB or persistent queue.
const jobs = {};

// Configure AWS S3 if chosen
let s3 = null;
if (STORAGE_PROVIDER === 's3') {
  AWS.config.update({
    region: AWS_REGION,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  });
  s3 = new AWS.S3();
  if (!S3_BUCKET) console.warn('STORAGE_PROVIDER=s3 but S3_BUCKET not set.');
} else {
  if (!fs.existsSync(LOCAL_STORAGE_DIR)) fs.mkdirSync(LOCAL_STORAGE_DIR, { recursive: true });
}

// Simple auth middleware: frontend must send Authorization: Bearer <PUBLIC_TOKEN>
function validatePublicToken(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!PUBLIC_TOKEN || token === PUBLIC_TOKEN) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized (invalid token)' });
}

// Util: simple sanitizer/heuristic preflight
function createPreflightResult(prompt, aspectRatio, resolution, quality) {
  const p = (prompt || '').trim();
  const summary = p.length <= 140 ? p : p.slice(0, 140) + '...';
  // naive frames: split sentences or chop by comma/length
  let frames = [];
  const sentences = p.split(/[.?!]\s/).filter(Boolean);
  if (sentences.length >= 3) frames = sentences.slice(0, 3);
  else {
    const parts = p.split(',').filter(Boolean);
    frames = parts.slice(0, 3);
  }
  if (frames.length === 0) frames = [p.slice(0, Math.min(80, p.length))];

  // warnings (naive): check for disallowed words
  const banned = ['terror', 'bomb', 'assassin', 'suicide', 'drugs']; // example
  const warnings = [];
  const pl = p.toLowerCase();
  banned.forEach(w => {
    if (pl.includes(w)) warnings.push(`Conteúdo sensível detectado: "${w}"`);
  });

  // estimate seconds based on resolution & quality
  let est = 20;
  if ((resolution || '').includes('720')) est = 12;
  if (quality === 'fast') {
    if ((resolution || '').includes('720')) est = 5;
    else est = 20;
  } else {
    // quality mode
    if ((resolution || '').includes('1080')) est = 80;
    else est = 40;
  }

  return {
    summary,
    frames,
    warnings,
    suggested_prompt: p,
    estimated_time_seconds: est,
    approved: warnings.length === 0
  };
}

// Endpoint: preflight
app.post('/api/preflight', validatePublicToken, (req, res) => {
  try {
    const { prompt, aspectRatio = '9:16', resolution = '720p', quality = 'fast' } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    const result = createPreflightResult(prompt, aspectRatio, resolution, quality);
    // Optionally track preflight requests (in memory)
    const preflightId = uuidv4();
    jobs[preflightId] = { type: 'preflight', createdAt: Date.now(), data: result };
    return res.json({ preflightId, ...result });
  } catch (err) {
    console.error('preflight error', err);
    return res.status(500).json({ error: 'preflight failed', detail: err.message });
  }
});

// Internal helper: upload buffer to storage (s3 or local), returns public url
async function uploadBufferToStorage(buffer, filename, mimetype = 'video/mp4') {
  if (STORAGE_PROVIDER === 's3') {
    const Key = filename;
    const params = {
      Bucket: S3_BUCKET,
      Key,
      Body: buffer,
      ContentType: mimetype,
      ACL: 'public-read'
    };
    await s3.putObject(params).promise();
    // build URL (assuming public-read)
    return `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${encodeURIComponent(Key)}`;
  } else {
    const filePath = path.join(LOCAL_STORAGE_DIR, filename);
    fs.writeFileSync(filePath, buffer);
    // For local dev we're returning a path; in real deploy you must serve static files or use S3.
    return `${reqBaseUrl()}/files/${encodeURIComponent(filename)}`;
  }
}

// helper to get base url for local files (not ideal in serverless)
function reqBaseUrl() {
  // try to read from env or fallback
  return process.env.APP_BASE_URL || (`http://localhost:${PORT}`);
}

// GET endpoint to serve local files (only for local storage testing)
app.get('/files/:filename', (req, res) => {
  if (STORAGE_PROVIDER === 's3') return res.status(404).send('not available');
  const filename = req.params.filename;
  const filePath = path.join(LOCAL_STORAGE_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('file not found');
  res.sendFile(path.resolve(filePath));
});

// Endpoint: generate
app.post('/api/generate', validatePublicToken, async (req, res) => {
  try {
    const { prompt, aspectRatio = '9:16', resolution = '720p', generateAudio = true, quality = 'fast', preflightId } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    // create job
    const jobId = uuidv4();
    jobs[jobId] = {
      id: jobId,
      status: 'queued',
      prompt,
      aspectRatio,
      resolution,
      generateAudio,
      quality,
      preflightId: preflightId || null,
      createdAt: Date.now(),
      progress: 0,
      result: null,
      error: null
    };

    // Immediately respond with job id and status
    res.json({ jobId, status: 'queued' });

    // Process job asynchronously
    (async () => {
      try {
        jobs[jobId].status = 'processing';
        jobs[jobId].progress = 5;

        if (!GEMINI_API_KEY) {
          // simulation mode: create a placeholder "video" file (not a real mp4) or return a note
          const text = `Simulated video for prompt: ${prompt}\n(You must configure GEMINI_API_KEY for real generation)`;
          const filename = `sim-${jobId}.txt`;
          const buffer = Buffer.from(text, 'utf8');
          const publicUrl = await (async () => {
            if (STORAGE_PROVIDER === 's3') {
              const Key = filename;
              await s3.putObject({ Bucket: S3_BUCKET, Key, Body: buffer, ContentType: 'text/plain', ACL: 'public-read' }).promise();
              return `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${encodeURIComponent(Key)}`;
            } else {
              const filePath = path.join(LOCAL_STORAGE_DIR, filename);
              fs.writeFileSync(filePath, buffer);
              return `${reqBaseUrl()}/files/${encodeURIComponent(filename)}`;
            }
          })();

          jobs[jobId].progress = 100;
          jobs[jobId].status = 'done';
          jobs[jobId].result = { url: publicUrl, info: 'SIMULATED_RESULT - configure GEMINI_API_KEY for real output' };

          // callback to frontend if provided
          if (req.body.callbackUrl || CALLBACK_URL) {
            const cb = req.body.callbackUrl || CALLBACK_URL;
            try {
              await axios.post(cb, { jobId, status: jobs[jobId].status, result: jobs[jobId].result });
            } catch (e) { console.warn('callback failed', e.message); }
          }
          return;
        }

        // If GEMINI_API_KEY is present, call Gemini Video generate endpoint
        const model = (quality === 'fast') ? 'veo-3.1-fast-generate-001' : 'veo-3.1-generate-001';
        const genUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateVideo`;
        const payload = {
          prompt,
          aspectRatio,
          resolution,
          generateAudio
        };

        jobs[jobId].progress = 10;

        const headers = {
          Authorization: `Bearer ${GEMINI_API_KEY}`,
          'Content-Type': 'application/json'
        };

        const genResp = await axios.post(genUrl, payload, { headers, timeout: 120000 });

        jobs[jobId].progress = 40;

        // Try to find video uri or base64 inside the response (APIs vary)
        // Common fields to check: genResp.data.output[0].uri  or genResp.data.outputUri  or genResp.data.result[0].uri
        let videoUrl = null;
        let videoBase64 = null;

        if (genResp.data) {
          // output array
          if (Array.isArray(genResp.data.output) && genResp.data.output.length > 0) {
            const out0 = genResp.data.output[0];
            if (out0.uri) videoUrl = out0.uri;
            else if (out0.content && out0.contentType && out0.contentType.startsWith('video')) {
              videoBase64 = out0.content; // hypothetical
            }
          }
          // other heuristics
          if (!videoUrl && genResp.data.outputUri) videoUrl = genResp.data.outputUri;
          if (!videoUrl && genResp.data.result && Array.isArray(genResp.data.result) && genResp.data.result[0] && genResp.data.result[0].uri) videoUrl = genResp.data.result[0].uri;
        }

        if (videoUrl) {
          // Download the video from videoUrl and upload to storage (or proxy)
          const downloadResp = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 120000 });
          const buf = Buffer.from(downloadResp.data);
          const filename = `veo-${jobId}.mp4`;
          let publicUrl;
          if (STORAGE_PROVIDER === 's3') {
            await s3.putObject({ Bucket: S3_BUCKET, Key: filename, Body: buf, ContentType: 'video/mp4', ACL: 'public-read' }).promise();
            publicUrl = `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${encodeURIComponent(filename)}`;
          } else {
            const filePath = path.join(LOCAL_STORAGE_DIR, filename);
            fs.writeFileSync(filePath, buf);
            publicUrl = `${reqBaseUrl()}/files/${encodeURIComponent(filename)}`;
          }
          jobs[jobId].progress = 100;
          jobs[jobId].status = 'done';
          jobs[jobId].result = { url: publicUrl, providerVideoUrl: videoUrl };
        } else if (videoBase64) {
          const buf = Buffer.from(videoBase64, 'base64');
          const filename = `veo-${jobId}.mp4`;
          if (STORAGE_PROVIDER === 's3') {
            await s3.putObject({ Bucket: S3_BUCKET, Key: filename, Body: buf, ContentType: 'video/mp4', ACL: 'public-read' }).promise();
            const publicUrl = `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${encodeURIComponent(filename)}`;
            jobs[jobId].result = { url: publicUrl };
          } else {
            const filePath = path.join(LOCAL_STORAGE_DIR, filename);
            fs.writeFileSync(filePath, buf);
            jobs[jobId].result = { url: `${reqBaseUrl()}/files/${encodeURIComponent(filename)}` };
          }
          jobs[jobId].progress = 100;
          jobs[jobId].status = 'done';
        } else {
          // unknown response shape - save raw response to a file for debugging
          const debugFilename = `debug-${jobId}.json`;
          const buf = Buffer.from(JSON.stringify(genResp.data || { empty: true }, null, 2), 'utf8');
          if (STORAGE_PROVIDER === 's3') {
            await s3.putObject({ Bucket: S3_BUCKET, Key: debugFilename, Body: buf, ContentType: 'application/json', ACL: 'public-read' }).promise();
            jobs[jobId].result = { debug: `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${encodeURIComponent(debugFilename)}` };
          } else {
            const filePath = path.join(LOCAL_STORAGE_DIR, debugFilename);
            fs.writeFileSync(filePath, buf);
            jobs[jobId].result = { debug: `${reqBaseUrl()}/files/${encodeURIComponent(debugFilename)}` };
          }
          jobs[jobId].status = 'failed';
          jobs[jobId].error = 'Could not parse provider response; check debug file.';
          jobs[jobId].progress = 100;
        }

        // callback if needed
        const cb = req.body.callbackUrl || CALLBACK_URL;
        if (cb) {
          try {
            await axios.post(cb, { jobId, status: jobs[jobId].status, result: jobs[jobId].result });
          } catch (e) {
            console.warn('callback error', e.message);
          }
        }
      } catch (err) {
        console.error('Job processing error', err && err.response ? err.response.data || err.message : err.message);
        jobs[jobId].status = 'failed';
        jobs[jobId].error = err && err.response ? err.response.data || err.message : String(err);
        jobs[jobId].progress = 100;
        // attempt callback
        const cb = req.body.callbackUrl || CALLBACK_URL;
        if (cb) {
          try {
            await axios.post(cb, { jobId, status: jobs[jobId].status, error: jobs[jobId].error });
          } catch (e) { console.warn('callback error', e.message); }
        }
      }
    })();

  } catch (err) {
    console.error('generate endpoint error', err);
    return res.status(500).json({ error: 'generate failed', detail: err.message });
  }
});

// Endpoint: job status
app.get('/api/job-status/:id', validatePublicToken, (req, res) => {
  const jobId = req.params.id;
  if (!jobId || !jobs[jobId]) return res.status(404).json({ error: 'job not found' });
  return res.json(jobs[jobId]);
});

// Basic health
app.get('/api/health', (req, res) => res.json({ ok: true, now: Date.now(), env: { STORAGE_PROVIDER } }));

app.listen(PORT, () => {
  console.log(`VeoMaker backend listening on port ${PORT}`);
});
