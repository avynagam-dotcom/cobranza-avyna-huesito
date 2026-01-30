"use strict";

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const CARD_FEE_FACTOR = 0.0406; // 3.5% + 16% IVA (3.5 * 1.16 = 4.06%)

const { ensureDir, auditLog, writeDatabaseAtomic } = require("./utils/persistence");

// ----- Paths
// ----- Paths configuration (Render Persistent Disk Support)
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");

// Detectar Persistent Disk de Render
const RENDER_DISK_PATH = "/var/data/cobranza";
// Usamos el disco solo si existe físicamente
const USE_PERSISTENT = fs.existsSync(RENDER_DISK_PATH);

let DATA_DIR, UPLOADS_DIR;

if (USE_PERSISTENT) {
  console.log(`[System] Usando Persistent Disk en: ${RENDER_DISK_PATH}`);
  DATA_DIR = path.join(RENDER_DISK_PATH, "data");
  UPLOADS_DIR = path.join(RENDER_DISK_PATH, "uploads");
} else {
  console.log(`[System] Usando almacenamiento local (ephemeral/local)`);
  DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
  UPLOADS_DIR = path.join(ROOT, "uploads");
}

const DB_FILE = path.join(DATA_DIR, "notas.json");

// ----- Backup Automático cada 24h a R2
const R2_ENABLED = process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET;
if (R2_ENABLED) {
  const backup = require("./scripts/backup");
  // Ejecutar uno al iniciar (después de 30s para no saturar el arranque)
  setTimeout(() => {
    backup().catch(err => console.error("[AutoBackup] Fallo inicial:", err.message));
  }, 30000);
  // Y luego cada 24 horas
  setInterval(() => {
    backup().catch(err => console.error("[AutoBackup] Fallo periódico:", err.message));
  }, 24 * 60 * 60 * 1000);
}

// Ensure folders exist (Critical for new locations)
ensureDir(DATA_DIR);
ensureDir(UPLOADS_DIR);


// ----- Migration: Local -> Persistent (Idempotent)
// Se ejecuta solo si estamos en Render (Persistent) y detectamos archivos locales que no están en el disco
if (USE_PERSISTENT) {
  try {
    const localDataDir = path.join(ROOT, "data");
    const localUploadsDir = path.join(ROOT, "uploads");

    function migrateFiles(srcDir, destDir) {
      if (!fs.existsSync(srcDir)) return;

      const files = fs.readdirSync(srcDir);
      let count = 0;

      for (const file of files) {
        if (file.startsWith(".")) continue; // Ignorar .DS_Store, etc

        const srcPath = path.join(srcDir, file);
        const destPath = path.join(destDir, file);

        try {
          // Solo copiamos si es archivo y NO existe en destino
          if (fs.statSync(srcPath).isFile() && !fs.existsSync(destPath)) {
            fs.copyFileSync(srcPath, destPath);
            count++;
          }
        } catch (e) {
          console.error(`[Migra] Error copiando ${file}:`, e.message);
        }
      }

      if (count > 0) console.log(`[Migra] Se migraron ${count} archivos de ${srcDir} a ${destDir}`);
    }

    migrateFiles(localDataDir, DATA_DIR);
    migrateFiles(localUploadsDir, UPLOADS_DIR);

  } catch (err) {
    console.error("[Migra] Fallo en proceso de migración:", err);
  }
}

// ----- DB helpers (Atomic & Audited)
function loadDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error("[CRITICAL] Failed to load DB:", err);
    }
    return [];
  }
}

// Direct usage of persistence utils
// Wrappers removed for clarity and lack of zombie code

// ----- Batch (miércoles 12:00)
function pad2(n) {
  return String(n).padStart(2, "0");
}
function ymd(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function getMexicoDate(date = new Date()) {
  const options = { timeZone: "America/Mexico_City", year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' };
  const formatter = new Intl.DateTimeFormat([], options);
  const parts = formatter.formatToParts(date);
  const get = (type) => parts.find(p => p.type === type).value;

  return new Date(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
}

function getCurrentBatchKey(now = new Date()) {
  // Usar hora de México para determinar el día
  const mxDate = getMexicoDate(now);

  // miércoles más reciente a las 12:00 (hora México)
  // JS: 0=Dom,1=Lun,2=Mar,3=Mié...
  const day = mxDate.getDay();
  let daysSinceWednesday = (day - 3 + 7) % 7; if (day === 3 && mxDate.getHours() < 12) daysSinceWednesday = 7;

  const d = new Date(mxDate);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - daysSinceWednesday);
  return ymd(d);
}

// ----- Date helpers (crédito)
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function iso(d) {
  return d ? new Date(d).toISOString() : null;
}

// ----- Extraction helpers
function parseMoney(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/\s/g, "");

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  const decPos = Math.max(lastDot, lastComma);

  let normalized;
  if (decPos === -1) {
    normalized = s.replace(/[^\d]/g, "");
  } else {
    const intPart = s.slice(0, decPos).replace(/[^\d]/g, "");
    const decPart = s.slice(decPos + 1).replace(/[^\d]/g, "").slice(0, 2);
    normalized = `${intPart}.${decPart}`;
  }

  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function extractTotalFromText(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // líneas con TOTAL pero NO SUBTOTAL
  const totalLines = lines
    .filter((l) => /total/i.test(l))
    .filter((l) => !/sub\s*total/i.test(l));

  const patterns = [
    /(TOTAL\s*A\s*PAGAR)\s*[:\-]?\s*\$?\s*([0-9][0-9.,\s]*)/i,
    /(IMPORTE\s*TOTAL)\s*[:\-]?\s*\$?\s*([0-9][0-9.,\s]*)/i,
    /(^|\b)(TOTAL)\s*[:\-]?\s*\$?\s*([0-9][0-9.,\s]*)/i,
  ];

  let candidates = [];

  for (const l of totalLines) {
    for (const p of patterns) {
      const m = l.match(p);
      if (m) {
        const moneyStr = m[m.length - 1];
        const val = parseMoney(moneyStr);
        if (val != null) candidates.push(val);
      }
    }
  }

  // fallback: todo el texto (última ocurrencia)
  if (candidates.length === 0) {
    for (const p of patterns) {
      const all = [...text.matchAll(p)];
      if (all.length) {
        const last = all[all.length - 1];
        const moneyStr = last[last.length - 1];
        const val = parseMoney(moneyStr);
        if (val != null) candidates.push(val);
      }
    }
  }

  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

function extractClienteFromText(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const sameLine = [
    /(CLIENTE)\s*[:\-]\s*(.+)$/i,
    /(NOMBRE)\s*[:\-]\s*(.+)$/i,
    /(RAZ[ÓO]N\s+SOCIAL)\s*[:\-]\s*(.+)$/i,
  ];
  for (const l of lines) {
    for (const p of sameLine) {
      const m = l.match(p);
      if (m && m[2]) {
        const v = m[2].trim();
        if (v && v.length >= 3) return v;
      }
    }
  }

  const nextLineLabels = [/^CLIENTE$/i, /^NOMBRE$/i, /^RAZ[ÓO]N\s+SOCIAL$/i];
  for (let i = 0; i < lines.length - 1; i++) {
    if (nextLineLabels.some((rx) => rx.test(lines[i]))) {
      const v = (lines[i + 1] || "").trim();
      if (v && v.length >= 3 && !/^(RFC|FECHA|FOLIO|TOTAL|SUBTOTAL)$/i.test(v)) return v;
    }
  }

  for (const l of lines) {
    const m = l.match(/^(\d{4,})\s*[-–—]\s*(.+)$/);
    if (m && m[2]) return `${m[1]} - ${m[2].trim()}`;
  }

  return null;
}

// ----- Crédito (estado en TIEMPO REAL)
function computeCredito(nota, now = new Date()) {
  const deliveredAt = nota.deliveredAt ? new Date(nota.deliveredAt) : null;
  const dueAt = nota.dueAt ? new Date(nota.dueAt) : null;

  const total = typeof nota.total === "number" && Number.isFinite(nota.total) ? nota.total : null;
  const pagado = typeof nota.pagado === "number" && Number.isFinite(nota.pagado) ? nota.pagado : 0;

  let saldo = null;
  if (total != null) saldo = Math.max(total - pagado, 0);

  let statusCredito = "PRE_ENTREGA";

  if (deliveredAt) {
    if (saldo === 0 && total != null) {
      statusCredito = "LIQUIDADO";
    } else if (dueAt) {
      const msNow = now.getTime();
      const msDue = dueAt.getTime();
      const threeDaysMs = 3 * 24 * 60 * 60 * 1000;

      if (msNow >= msDue) statusCredito = "VENCIDO";
      else if (msNow >= msDue - threeDaysMs) statusCredito = "POR_VENCER";
      else statusCredito = "EN_PLAZO";
    } else {
      statusCredito = "EN_PLAZO";
    }
  }

  return {
    deliveredAt: nota.deliveredAt || null,
    dueAt: nota.dueAt || null,
    saldo,
    statusCredito,
  };
}

// ----- Multer (PDF upload)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
});

// ----- Static
app.use(express.static(PUBLIC_DIR));

// ----- API: listar notas
app.get("/api/notas", (req, res) => {
  const notas = loadDB();
  const batchKey = getCurrentBatchKey();
  const now = new Date();
  const notasWithCredito = notas.map((n) => ({ ...n, ...computeCredito(n, now) }));
  res.json({ batchKey, notas: notasWithCredito });
});

// ----- API: subir PDF
// ----- API: subir PDF (Data Shielding)
app.post("/api/upload", upload.single("pdf"), async (req, res) => {
  const ACTION = "UPLOAD_PDF";
  const reqId = crypto.randomUUID();

  try {
    // 1. Edge Validation
    if (!req.file || !req.file.buffer) {
      auditLog(DATA_DIR, ACTION, "BLOCKED", { reqId, reason: "No PDF buffer" });

      return res.status(400).json({ ok: false, message: "No se recibió PDF" });
    }
    const originalName = req.file.originalname || "nota.pdf";
    const batchKey = getCurrentBatchKey();

    auditLog(DATA_DIR, ACTION, "ATTEMPT", { reqId, originalName, batchKey });


    // 2. Process (Read-Modify-Write Lock simulation)
    const notas = loadDB();

    const existingIdx = notas.findIndex(
      (n) =>
        String(n.batchKey) === String(batchKey) &&
        String(n.originalName || "").toLowerCase() === String(originalName).toLowerCase()
    );

    const parsed = await pdfParse(req.file.buffer);
    const text = parsed && parsed.text ? parsed.text : "";
    const cliente = extractClienteFromText(text) || null;
    const total = extractTotalFromText(text);
    const uploadedAt = new Date().toISOString();

    let responseNota = null;

    if (existingIdx !== -1) {
      const ex = notas[existingIdx];
      // Block duplicate delivered
      if (ex.deliveredAt) {
        auditLog(DATA_DIR, ACTION, "BLOCKED", { reqId, reason: "Duplicate delivered", notaId: ex.id });

        return res.json({ ok: false, duplicate: true, message: "Nota duplicada (ya entregada)" });
      }

      // Update existing
      ex.cliente = cliente;
      ex.total = typeof total === "number" && Number.isFinite(total) ? total : null;
      ex.uploadedAt = uploadedAt;

      const filename = ex.filename || `${batchKey}__${ex.id}__${originalName}`.replace(/[^\w.\-() \u00C0-\u017F]/g, "_");
      ex.filename = filename;

      const filePath = path.join(UPLOADS_DIR, filename);
      fs.writeFileSync(filePath, req.file.buffer);

      notas[existingIdx] = ex;
      responseNota = ex;
    } else {
      // Create new
      const id = crypto.randomUUID();
      const safeName = `${batchKey}__${id}__${originalName}`.replace(/[^\w.\-() \u00C0-\u017F]/g, "_");
      const filePath = path.join(UPLOADS_DIR, safeName);
      fs.writeFileSync(filePath, req.file.buffer);

      const nota = {
        id,
        batchKey,
        originalName,
        filename: safeName,
        cliente,
        total: typeof total === "number" && Number.isFinite(total) ? total : null,
        pagado: 0,
        deliveredAt: null,
        dueAt: null,
        firstPaymentAt: null,
        uploadedAt,
        pagos: []
      };
      notas.push(nota);
      responseNota = nota;
    }

    // 3. Atomic Persistence
    const success = writeDatabaseAtomic(DB_FILE, notas, DATA_DIR);

    if (!success) {
      auditLog(DATA_DIR, ACTION, "FAILURE", { reqId, reason: "Disk write failed" });

      return res.status(500).json({ ok: false, message: "Error interno de persistencia" });
    }

    auditLog(DATA_DIR, ACTION, "SUCCESS", { reqId, notaId: responseNota.id });

    return res.json({ ok: true, nota: { ...responseNota, ...computeCredito(responseNota) } });

  } catch (e) {
    auditLog(DATA_DIR, ACTION, "CRITICAL_ERROR", { reqId, error: e.message, stack: e.stack });

    console.error("UPLOAD ERROR:", e);
    return res.status(500).json({ ok: false, message: "Error procesando PDF" });
  }
});

// ----- API: marcar ENTREGADO (inicio crédito)
// ----- API: marcar ENTREGADO (inicio crédito)
app.post("/api/entregar", (req, res) => {
  const ACTION = "MARK_DELIVERED";
  const reqId = crypto.randomUUID();

  try {
    const { id } = req.body || {};
    if (!id) {
      auditLog(DATA_DIR, ACTION, "BLOCKED", { reqId, reason: "Missing ID" });

      return res.status(400).json({ ok: false, message: "Falta id" });
    }

    auditLog(DATA_DIR, ACTION, "ATTEMPT", { reqId, notaId: id });


    // Transaction start
    const notas = loadDB();
    const idx = notas.findIndex((n) => String(n.id) === String(id));
    if (idx === -1) {
      auditLog(DATA_DIR, ACTION, "BLOCKED", { reqId, reason: "Nota Not Found", notaId: id });

      return res.status(404).json({ ok: false, message: "Nota no encontrada" });
    }

    const n = notas[idx];
    if (n.deliveredAt) {
      // Idempotency: log but don't error? Or just return ok?
      // Let's treat as success but no-op
      auditLog(DATA_DIR, ACTION, "NO_OP", { reqId, reason: "Already delivered", notaId: id });

    } else {
      const now = new Date();
      n.deliveredAt = iso(now);
      n.dueAt = iso(addDays(now, 15));

      notas[idx] = n;

      // Atomic Commit
      if (!writeDatabaseAtomic(DB_FILE, notas, DATA_DIR)) {

        auditLog(DATA_DIR, ACTION, "FAILURE", { reqId, reason: "Disk write failed" });

        return res.status(500).json({ ok: false, message: "DB Error" });
      }
    }

    auditLog(DATA_DIR, ACTION, "SUCCESS", { reqId, notaId: id });

    return res.json({ ok: true, nota: { ...n, ...computeCredito(n) } });

  } catch (e) {
    auditLog(DATA_DIR, ACTION, "CRITICAL_ERROR", { reqId, error: e.message });

    console.error("ENTREGAR ERROR:", e);
    return res.status(500).json({ ok: false, message: "Error al marcar entregado" });
  }
});

// ----- API: registrar pago
// ----- API: registrar pago
app.post("/api/pago", (req, res) => {
  const ACTION = "REGISTER_PAYMENT";
  const reqId = crypto.randomUUID();

  try {
    const { id, monto, metodo } = req.body || {};
    const val = Number(monto);
    const mtd = metodo || "efectivo";

    // Edge Validation
    if (!id || !Number.isFinite(val) || val <= 0) {
      auditLog(DATA_DIR, ACTION, "BLOCKED", { reqId, reason: "Invalid Payload", payload: req.body });

      return res.status(400).json({ ok: false, message: "Datos inválidos" });
    }

    auditLog(DATA_DIR, ACTION, "ATTEMPT", { reqId, notaId: id, monto: val, metodo: mtd });


    const notas = loadDB();
    const idx = notas.findIndex((n) => String(n.id) === String(id));
    if (idx === -1) {
      auditLog(DATA_DIR, ACTION, "BLOCKED", { reqId, reason: "Nota Not Found", notaId: id });

      return res.status(404).json({ ok: false, message: "Nota no encontrada" });
    }

    const n = notas[idx];

    let comision = 0;
    if (mtd === "tarjeta") {
      comision = val * CARD_FEE_FACTOR;
    }

    if (!n.pagos) n.pagos = [];

    // Migration logic safe-guard
    if (n.pagado > 0 && n.pagos.length === 0) {
      n.pagos.push({
        monto: n.pagado,
        metodo: "efectivo",
        comision: 0,
        fecha: n.firstPaymentAt || n.uploadedAt
      });
    }

    const nuevoPago = {
      monto: val,
      metodo: mtd,
      comision: Number(comision.toFixed(2)),
      fecha: new Date().toISOString()
    };

    n.pagos.push(nuevoPago);
    n.pagado = Number((n.pagado || 0) + val);

    if (n.deliveredAt && !n.firstPaymentAt) {
      n.firstPaymentAt = nuevoPago.fecha;
    }

    notas[idx] = n;

    // Atomic Commit
    if (!writeDatabaseAtomicWrapper(notas)) {
      auditLog(DATA_DIR, ACTION, "FAILURE", { reqId, reason: "Disk Write Failed" });

      return res.status(500).json({ ok: false, message: "Error interno" });
    }

    auditLog(DATA_DIR, ACTION, "SUCCESS", { reqId, notaId: id, nuevoSaldo: computeCredito(n).saldo });

    return res.json({ ok: true, nota: { ...n, ...computeCredito(n) } });

  } catch (e) {
    auditLog(DATA_DIR, ACTION, "CRITICAL_ERROR", { reqId, error: e.message });

    console.error("PAGO ERROR:", e);
    return res.status(500).json({ ok: false, message: "Error al registrar pago" });
  }
});

// ----- API: eliminar nota
// ----- API: eliminar nota
app.delete("/api/notas/:id", (req, res) => {
  const ACTION = "DELETE_NOTA";
  const reqId = crypto.randomUUID();

  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ ok: false, message: "Falta id" });

    auditLog(DATA_DIR, ACTION, "ATTEMPT", { reqId, notaId: id });


    const notas = loadDB();
    const idx = notas.findIndex((n) => String(n.id) === String(id));
    if (idx === -1) {
      auditLog(DATA_DIR, ACTION, "BLOCKED", { reqId, reason: "Not Found" });

      return res.status(404).json({ ok: false, message: "Nota no encontrada" });
    }

    const n = notas[idx];

    // Intentar borrar el archivo físico
    if (n.filename) {
      const filePath = path.join(UPLOADS_DIR, n.filename);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (err) {
          console.error(`[Delete] Error borrando archivo ${n.filename}:`, err.message);
          // Non-critical (?) - Log it
          auditLog(DATA_DIR, ACTION, "WARNING", { reqId, warning: "File unlink failed", file: n.filename });

        }
      }
    }

    // Quitar de la DB
    notas.splice(idx, 1);

    if (!writeDatabaseAtomicWrapper(notas)) {
      auditLog(DATA_DIR, ACTION, "FAILURE", { reqId, reason: "Disk Write Failed" });

      return res.status(500).json({ ok: false, message: "Error interno" });
    }

    auditLog(DATA_DIR, ACTION, "SUCCESS", { reqId, notaId: id });

    return res.json({ ok: true, message: "Nota eliminada" });
  } catch (e) {
    auditLog(DATA_DIR, ACTION, "CRITICAL_ERROR", { reqId, error: e.message });

    console.error("DELETE ERROR:", e);
    return res.status(500).json({ ok: false, message: "Error al eliminar nota" });
  }
});

// ----- KPIs globales (SOLO ENTREGADAS) ✅ consistencia y utilidades
app.get("/api/kpis", (req, res) => {
  const notas = loadDB();
  const entregadas = notas.filter((n) => !!n.deliveredAt);

  let totalCobrable = 0;
  let totalCobrado = 0;
  let totalComisiones = 0;

  for (const n of entregadas) {
    const total = typeof n.total === "number" && Number.isFinite(n.total) ? n.total : 0;
    const pagado = typeof n.pagado === "number" && Number.isFinite(n.pagado) ? n.pagado : 0;

    totalCobrable += total;
    totalCobrado += Math.min(pagado, total);

    // Sumar comisiones bancarias
    if (n.pagos) {
      for (const p of n.pagos) {
        totalComisiones += (p.comision || 0);
      }
    }
  }

  // ✅ saldo = cobrable - cobrado (evita discrepancias)
  const totalSaldo = Math.max(totalCobrable - totalCobrado, 0);
  const pctCobranza = totalCobrable > 0 ? totalCobrado / totalCobrable : 0;

  // Utilidad NETA (restando comisiones bancarias del 40% de utilidad bruta)
  const utilidadCobradaBruta = totalCobrado * 0.4;
  const utilidadCobrada = Math.max(utilidadCobradaBruta - totalComisiones, 0);
  const utilidadPorCobrar = totalSaldo * 0.4;

  res.json({
    ok: true,
    totalCobrable,
    totalCobrado,
    totalSaldo,
    pctCobranza,
    utilidadCobrada,
    utilidadPorCobrar,
    totalComisiones: Number(totalComisiones.toFixed(2)),
  });
});

// ----- quién falta por pagar (entregadas con saldo)
app.get("/api/faltantes", (req, res) => {
  const notas = loadDB();
  const now = new Date();

  const faltantes = notas
    .filter((n) => !!n.deliveredAt)
    .map((n) => ({ ...n, ...computeCredito(n, now) }))
    .filter((n) => (typeof n.saldo === "number" ? n.saldo > 0 : true))
    .sort((a, b) => {
      const rank = (s) =>
        s === "VENCIDO" ? 0 : s === "POR_VENCER" ? 1 : s === "EN_PLAZO" ? 2 : 3;
      const ra = rank(a.statusCredito);
      const rb = rank(b.statusCredito);
      if (ra !== rb) return ra - rb;

      const da = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
      const db = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
      return da - db;
    });

  res.json({ ok: true, faltantes });
});

// ----- Start
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  console.log(`Batch actual (miércoles 12:00): ${getCurrentBatchKey()}`);
});