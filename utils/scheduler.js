const cron = require("node-cron");
const runBackup = require("../scripts/backup");

function initScheduler() {
    console.log("[Scheduler] 🕒 Inicializando cron jobs...");

    // Ejecutar todos los días a las 09:00 UTC (03:00 AM CDMX)
    cron.schedule("0 9 * * *", async () => {
        console.log("[Scheduler] ⏰ Ejecutando backup automático diario...");
        try {
            await runBackup();
        } catch (error) {
            console.error("[Scheduler] ❌ Error en el backup automático:", error);
        }
    }, {
        timezone: "UTC"
    });

    console.log("[Scheduler] ✅ Backup programado para las 09:00 UTC diariamente.");
}

module.exports = { initScheduler };
