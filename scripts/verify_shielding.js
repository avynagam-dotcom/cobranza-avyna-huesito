const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

const AUDIT_FILE = path.join(__dirname, "../data/audit.jsonl");

async function runTest() {
    console.log("🚀 Starting Server...");
    const server = spawn("node", ["server.js"], { cwd: path.join(__dirname, "..") });

    server.stdout.on("data", (data) => console.log(`[Server]: ${data}`));
    server.stderr.on("data", (data) => console.error(`[Server ERR]: ${data}`));

    // Give it time to start
    await new Promise(r => setTimeout(r, 3000));

    console.log("🧪 Sending Invalid Request...");

    const postData = JSON.stringify({ monto: -50, id: "test-id" });
    const options = {
        hostname: 'localhost',
        port: 4000,
        path: '/api/pago',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    const req = http.request(options, (res) => {
        console.log(`STATUS: ${res.statusCode}`);
        res.setEncoding('utf8');
        res.on('data', (chunk) => console.log(`BODY: ${chunk}`));
        res.on('end', () => {
            console.log('No more data in response.');
            verifyAudit(server);
        });
    });

    req.on('error', (e) => {
        console.error(`problem with request: ${e.message}`);
        server.kill();
        process.exit(1);
    });

    req.write(postData);
    req.end();
}

function verifyAudit(server) {
    console.log("🔍 Verifying Audit Log...");
    try {
        if (fs.existsSync(AUDIT_FILE)) {
            const content = fs.readFileSync(AUDIT_FILE, "utf8");
            console.log("Audit Content:\n", content);
            if (content.includes("BLOCKED") && content.includes("Invalid Payload")) {
                console.log("✅ SUCCESS: Audit log contains expected BLOCK event.");
                cleanup(server, 0);
            } else {
                console.error("❌ FAILURE: Audit log missing expected event.");
                cleanup(server, 1);
            }
        } else {
            console.error("❌ FAILURE: Audit file not found.");
            cleanup(server, 1);
        }
    } catch (err) {
        console.error("Error reading audit:", err);
        cleanup(server, 1);
    }
}

function cleanup(server, code) {
    server.kill();
    process.exit(code);
}

runTest();
