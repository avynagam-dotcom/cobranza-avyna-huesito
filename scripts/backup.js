"use strict";

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// Validado -> Huesito
async function runBackup() {
    const PREFIX = "huesito";
    const R2_ENDPOINT = process.env.R2_ENDPOINT;
    const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
    const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
    const R2_BUCKET = process.env.R2_BUCKET;

    // Usar la variable de entorno validada por persistence.js
    const DATA_DIR = process.env.DATA_DIR;

    if (!DATA_DIR) {
        console.error("[Backup] ❌ ERROR: process.env.DATA_DIR no está definido.");
        return;
    }

    if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
        console.warn("[Backup] ⚠️ Faltan credenciales R2. Saltando backup.");
        return;
    }

    const date = new Date().toISOString().split("T")[0];
    const filename = `backup-${date}.tar.gz`;
    const key = `${PREFIX}/${filename}`;
    const archivePath = path.join("/tmp", filename);

    try {
        console.log(`[Backup] ⏳ Iniciando respaldo para: ${PREFIX}`);
        console.log(`[Backup] 📂 Origen (DATA_DIR): ${DATA_DIR}`);

        // Verificamos si existe la carpeta
        if (!fs.existsSync(DATA_DIR)) {
            console.warn(`[Backup] ⚠️ La carpeta ${DATA_DIR} no existe. Nada que respaldar.`);
            return;
        }

        console.log(`[Backup] 📦 Comprimiendo contenido de ${DATA_DIR} en ${archivePath}`);

        const parentDir = path.dirname(DATA_DIR);
        const dataDirName = path.basename(DATA_DIR);
        const uploadsPath = path.join(parentDir, "uploads");

        let targets = [dataDirName];
        if (fs.existsSync(uploadsPath)) {
            targets.push("uploads");
        }

        // Logic: tar -czf archive -C parentDir data uploads
        execSync(`tar -czf ${archivePath} -C ${parentDir} ${targets.join(" ")}`);

        console.log(`[Backup] 🚀 Subiendo a Cloudflare R2: ${R2_BUCKET} -> ${key}`);
        const s3 = new S3Client({
            region: "auto",
            endpoint: R2_ENDPOINT,
            credentials: {
                accessKeyId: R2_ACCESS_KEY_ID,
                secretAccessKey: R2_SECRET_ACCESS_KEY,
            },
        });

        const fileBuffer = fs.readFileSync(archivePath);
        await s3.send(new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: key,
            Body: fileBuffer,
            ContentType: "application/gzip",
        }));

        console.log(`[Backup] ✅ ÉXITO. Backup guardado: ${key}`);

    } catch (error) {
        console.error(`[Backup] ❌ ERROR CRÍTICO:`, error.message);
        throw error;
    } finally {
        if (fs.existsSync(archivePath)) {
            fs.unlinkSync(archivePath);
        }
    }
}

module.exports = runBackup;

if (require.main === module) {
    runBackup().catch((e) => {
        console.error("Manual Backup Failed:", e.message);
        process.exit(1);
    });
}
