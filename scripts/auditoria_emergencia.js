const fs = require('fs');
const path = require('path');

const TARGETS = [
    '/Users/Netie/cobranza-avyna-huesito/data/notas.json',
    '/Users/Netie/cobranza-avyna-operado/data/notas.json'
];

function auditAndFix(filePath) {
    console.log(`\n--- Auditing: ${filePath} ---`);
    if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        return;
    }

    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        console.error(`Error reading file: ${err.message}`);
        return;
    }

    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        console.error(`Invalid JSON in ${filePath}`);
        return;
    }

    if (!Array.isArray(data)) {
        console.error(`Root is not an array: ${filePath}. Content: ${JSON.stringify(data).substring(0, 100)}...`);
        return;
    }

    let fixedCount = 0;
    let inconsistentCount = 0;

    data.forEach((nota, index) => {
        let changed = false;

        // 1. Ensure pagos array exists
        if (!nota.hasOwnProperty('pagos') || !Array.isArray(nota.pagos)) {
            nota.pagos = [];
            changed = true;
        }

        // 2. Consistency Check
        const sumPagos = nota.pagos.reduce((sum, p) => sum + (Number(p.monto) || 0), 0);

        // Ensure numeric pagado
        if (typeof nota.pagado !== 'number') {
            nota.pagado = Number(nota.pagado) || 0;
            changed = true;
        }

        const currentPagado = nota.pagado;

        // Helper to compare floats
        if (Math.abs(currentPagado - sumPagos) > 0.05) { // tolerance
            console.warn(`[${index}] Note ${nota.id} (${nota.cliente}): Inconsistency detected. pagado=${currentPagado}, sum(pagos)=${sumPagos}`);

            if (sumPagos === 0 && currentPagado > 0) {
                console.log(`   -> Correction: Creating LEGACY payment of ${currentPagado} to match 'pagado'.`);
                nota.pagos.push({
                    monto: currentPagado,
                    metodo: 'legacy',
                    fecha: new Date().toISOString(),
                    isLegacy: true,
                    nota: 'Corrección auditoría emergencia'
                });
                changed = true;
            } else {
                console.log(`   -> Correction: Updating 'pagado' from ${currentPagado} to ${sumPagos} to match detailed payments.`);
                nota.pagado = sumPagos;
                changed = true;
            }
            inconsistentCount++;
        }

        if (changed) fixedCount++;
    });

    if (fixedCount > 0 || inconsistentCount > 0) {
        const backupPath = filePath + '.audit_bak_' + Date.now();
        fs.writeFileSync(backupPath, raw);
        console.log(`Backup created at ${backupPath}`);

        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        console.log(`Saved fixes. Notes repaired: ${fixedCount}`);
    } else {
        console.log("No issues found. File is clean.");
    }
}

TARGETS.forEach(auditAndFix);
