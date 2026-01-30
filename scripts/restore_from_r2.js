const { S3Client, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const stream = require("stream");
const { promisify } = require("util");
const pipeline = promisify(stream.pipeline);

async function restore() {
    const SYSTEM_NAME = process.env.SYSTEM_NAME || "cobranza-avyna-huesito";

    // Config from Env
    const R2_ENDPOINT = process.env.R2_ENDPOINT;
    const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
    const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
    const R2_BUCKET = process.env.R2_BUCKET;

    if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
        console.error("❌ Missing Environment Variables: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET");
        process.exit(1);
    }

    const s3 = new S3Client({
        region: "auto",
        endpoint: R2_ENDPOINT,
        credentials: {
            accessKeyId: R2_ACCESS_KEY_ID,
            secretAccessKey: R2_SECRET_ACCESS_KEY,
        },
    });

    console.log(`🔍 Listing backups for ${SYSTEM_NAME} in bucket ${R2_BUCKET}...`);

    // List objects with prefix
    // Assuming structure: SYSTEM_NAME/backup-SYSTEM_NAME-DATE.tar.gz
    // or just backup-SYSTEM_NAME-DATE.tar.gz? 
    // Based on backup.js: Key: `${SYSTEM_NAME}/${filename}`
    const prefix = `${SYSTEM_NAME}/`;

    try {
        const listCmd = new ListObjectsV2Command({
            Bucket: R2_BUCKET,
            Prefix: prefix
        });

        const response = await s3.send(listCmd);
        const contents = response.Contents || [];

        if (contents.length === 0) {
            console.error(`❌ No backups found for prefix: ${prefix}`);
            return;
        }

        // Sort by LastModified descending
        contents.sort((a, b) => b.LastModified - a.LastModified);

        // Filter out empty backups (e.g. < 500 bytes)
        const validBackups = contents.filter(c => c.Size > 500);

        if (validBackups.length === 0) {
            console.error("❌ No valid backups found (all are empty).");
            return;
        }

        const latest = validBackups[0];
        console.log(`✅ Found latest VALID backup: ${latest.Key} (${latest.Size} bytes) - ${latest.LastModified}`);

        /*
        console.log("Found backups:");
        contents.forEach(c => console.log(`- ${c.Key} (${c.Size} bytes) - ${c.LastModified}`));
        
        // Pick the latest one that is NOT suspiciously small (e.g. > 500 bytes)
        // or just let me see the list first.
        // For now, let's just log them and exit so I can decide.
        return; 
        */

        // Download
        const downloadPath = path.join(__dirname, "..", "latest_backup.tar.gz");
        console.log(`⬇️ Downloading to ${downloadPath}...`);

        const getCmd = new GetObjectCommand({
            Bucket: R2_BUCKET,
            Key: latest.Key
        });

        const data = await s3.send(getCmd);
        await pipeline(data.Body, fs.createWriteStream(downloadPath));

        console.log("📦 Extracting backup...");
        // Extract using tar
        // -x: extract, -z: gzip, -f: file, -C: change dir
        const targetDir = path.join(__dirname, "..");
        execSync(`tar -xzf "${downloadPath}" -C "${targetDir}"`);

        console.log("🧹 Cleaning up...");
        fs.unlinkSync(downloadPath);

        console.log("🎉 Restore successful! Data and Uploads updated.");

    } catch (error) {
        console.error("❌ Error during restore:", error);
    }
}

restore();
