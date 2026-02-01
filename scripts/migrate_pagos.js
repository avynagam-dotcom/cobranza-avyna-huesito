const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "notas.json");
const BAK_FILE = path.join(DATA_DIR, "notas.json.bak");

function migrate() {
    console.log("➡️ Iniciando migración de 'pagado' a 'pagos'...");

    if (!fs.existsSync(DB_FILE)) {
        console.error("❌ No se encontró notas.json");
        process.exit(1);
    }

    // 1. Backup
    console.log(`📦 Creando backup en ${BAK_FILE}...`);
    fs.copyFileSync(DB_FILE, BAK_FILE);
    console.log("✅ Backup creado.");

    // 2. Leer datos
    const raw = fs.readFileSync(DB_FILE, "utf8");
    let notas = JSON.parse(raw);

    if (!Array.isArray(notas)) {
        console.error("❌ El archivo notas.json no es un array.");
        process.exit(1);
    }

    let modifiedCount = 0;
    let errorCount = 0;

    notas = notas.map(n => {
        // Asegurar estructura base
        if (!n.pagos) n.pagos = [];

        const pagadoNum = typeof n.pagado === "number" ? n.pagado : 0;
        const pagosSum = n.pagos.reduce((sum, p) => sum + (p.monto || 0), 0);

        // Caso 1: Tiene 'pagado' pero no tiene pagos (o pagos vacíos)
        if (pagadoNum > 0 && pagosSum === 0) {
            console.log(`⚠️ Migrando nota ${n.id} (${n.cliente}): Pagado ${pagadoNum} -> Legacy Payment`);

            n.pagos.push({
                monto: pagadoNum,
                metodo: "legacy",
                fecha: n.firstPaymentAt || n.uploadedAt || new Date().toISOString(),
                isLegacy: true,
                nota: "Migración automática de saldo anterior"
            });

            modifiedCount++;
        }
        // Caso 2: Tiene pagos y pagado, verificamos consistencia
        else if (Math.abs(pagadoNum - pagosSum) > 0.01) {
            // Si hay diferencia, preferimos NO tocar automáticamente para no borrar datos, 
            // pero si 'pagos' está vacío y pagado > 0 ya lo cubrió el caso 1.
            // Si ambos tienen datos y difieren, es un conflicto.
            // ESTRATEGIA: Asumiremos que 'pagado' era la verdad absoluta histórica.
            // Si la suma de pagos es MENOR que pagado, agregamos la diferencia como Legacy.

            if (pagadoNum > pagosSum) {
                const diff = pagadoNum - pagosSum;
                console.log(`🔧 Corrigiendo diferencia nota ${n.id}: Faltan ${diff} en pagos.`);
                n.pagos.push({
                    monto: Number(diff.toFixed(2)),
                    metodo: "legacy_diff",
                    fecha: n.firstPaymentAt || new Date().toISOString(),
                    isLegacy: true
                });
                modifiedCount++;
            } else {
                // Si pagosSum > pagado, actualizamos 'pagado' para reflejar la realidad de los pagos
                console.log(`ℹ️ Actualizando 'pagado' nota ${n.id}: ${pagadoNum} -> ${pagosSum} (basado en pagos explícitos)`);
                n.pagado = pagosSum;
                modifiedCount++;
            }
        }

        // Recalcular final para garantizar integridad 100%
        const finalSum = n.pagos.reduce((sum, p) => sum + (p.monto || 0), 0);
        n.pagado = Number(finalSum.toFixed(2));

        return n;
    });

    // 3. Guardar
    console.log(`💾 Guardando cambios... (${modifiedCount} notas modificadas)`);
    fs.writeFileSync(DB_FILE, JSON.stringify(notas, null, 2));
    console.log("🚀 Migración completada con éxito.");
}

migrate();
