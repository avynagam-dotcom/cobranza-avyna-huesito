const cron = require('node-cron');
const { runBackup } = require('../scripts/backup');

function initScheduler() {
    const SYSTEM_NAME = process.env.SYSTEM_NAME || 'Unknown System';
    console.log(`⏰ [Scheduler] [${SYSTEM_NAME}] Iniciando cron job (09:00 UTC)...`);

    // 0 9 * * * => 9:00 AM UTC (3:00 AM CDMX aprox)
    cron.schedule('0 9 * * *', async () => {
        console.log(`⏰ [Scheduler] [${SYSTEM_NAME}] Ejecutando backup automático...`);
        try {
            await runBackup();
        } catch (err) {
            console.error(`❌ [Scheduler] [${SYSTEM_NAME}] Error en backup:`, err);
        }
    });

    // 0 0 1 * * => 1ro de mes a media noche (Histórico Mensual)
    cron.schedule('0 0 1 * *', () => {
        console.log(`📅 [Scheduler] [${SYSTEM_NAME}] Generando Snapshot Mensual (Bóveda)...`);
        try {
            const fs = require('fs');
            const path = require('path');
            const DATA = process.env.DATA_DIR || path.join(__dirname, '../data');
            const VAULT = path.join(DATA, 'backups/historicos');
            if (!fs.existsSync(VAULT)) fs.mkdirSync(VAULT, { recursive: true });

            const src = path.join(DATA, 'notas.json');
            if (fs.existsSync(src)) {
                const dest = path.join(VAULT, `${new Date().toISOString().slice(0, 7)}_notas.json`);
                fs.copyFileSync(src, dest);
                console.log(`✅ [VAULT] Snapshot guardado en ${dest}`);
            }
        } catch (e) { console.error('❌ [VAULT] Error:', e); }
    });
}

module.exports = { initScheduler };
