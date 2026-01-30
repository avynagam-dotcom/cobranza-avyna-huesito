"use strict";

const fs = require("fs");
const path = require("path");

// Configuration will be injected or read from process.env
// We expect DATA_DIR to be set in process.env or passed slightly, 
// but for this helper we can rely on process.env.DATA_DIR or a default if called from server.
// However, server.js initializes DATA_DIR logic (local vs persistent).
// To avoid circular deps or complex init, we'll export functions that accept paths or defaults.

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function getAuditFile(dataDir) {
    return path.join(dataDir, "audit.jsonl");
}

function auditLog(dataDir, action, status, meta = {}) {
    const auditFile = getAuditFile(dataDir);
    const entry = {
        timestamp: new Date().toISOString(),
        action,
        status, // "ATTEMPT", "SUCCESS", "FAILURE", "BLOCKED"
        ...meta
    };
    try {
        fs.appendFileSync(auditFile, JSON.stringify(entry) + "\n");
    } catch (e) {
        console.error("[CRITICAL] Failed to write audit log:", e);
    }
}

/**
 * Atomic write with validation:
 * 1. Write to .tmp
 * 2. Sync to disk
 * 3. Check size > 0
 * 4. Rename to target
 */
function writeDatabaseAtomic(filePath, dataObj, dataDir) { // dataDir needed for audit logging internally if we wanted, but we can return success/fail
    const tempFile = `${filePath}.tmp`;

    try {
        const jsonContent = JSON.stringify(dataObj, null, 2);

        // 1. Write to temp file
        fs.writeFileSync(tempFile, jsonContent, "utf8");

        // 2. Force flush to disk
        const fd = fs.openSync(tempFile, 'r+');
        fs.fsyncSync(fd);
        fs.closeSync(fd);

        // 3. Validation: Size > 0
        const stats = fs.statSync(tempFile);
        if (stats.size === 0) {
            throw new Error("Zero byte write detected");
        }

        // 4. Atomic rename
        fs.renameSync(tempFile, filePath);
        return true;
    } catch (err) {
        console.error("[CRITICAL] Atomic Write Failed:", err);
        // Try to cleanup temp if exists
        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch { }
        return false;
    }
}

module.exports = {
    ensureDir,
    auditLog,
    writeDatabaseAtomic
};
