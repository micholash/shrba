// ═══════════════════════════════════════════════════════════════
//  game.js  ·  심연의 미로 — 메인 게임 로직
//  fixes: keyTimeStats dt 누적, wrongQuestions 기록
//  new:   Web Serial 조이스틱, 좌우=카메라 회전, 퀴즈 조이스틱 탐색
// ═══════════════════════════════════════════════════════════════

import { initializeApp }  from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getDatabase, ref, push } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";

// ── Firebase ──────────────────────────────────────────────────
const firebaseConfig = {
    apiKey:            "AIzaSyA7kuCSB9UsaCtOYIhsQGuil0-g5rIh_Fs",
    authDomain:        "bloodborne-b1aae.firebaseapp.com",
    databaseURL:       "https://bloodborne-b1aae-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId:         "bloodborne-b1aae",
    storageBucket:     "bloodborne-b1aae.firebasestorage.app",
    messagingSenderId: "415284045901",
    appId:             "1:415284045901:web:ec45dcb66a955811c45404"
};
const db = getDatabase(initializeApp(firebaseConfig));

async function saveGameStats(stats) {
    try {
        await push(ref(db, "game_clears"), {
            ...stats,
            serverTimestamp: new Date().toISOString()
        });
        console.log("✅ Firebase 저장 완료", stats);
    } catch (e) {
        console.error("❌ Firebase 저장 실패:", e);
    }
}

// ── Groq API ──────────────────────────────────────────────────
const GROQ_API_KEY = "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";

// ── Constants ─────────────────────────────────────────────────
const COLS         = 32;
const ROWS         = 20;
const PLAYER_SPEED = 0.07;
const CHASER_SPEED = PLAYER_SPEED * 1.05;
const JOY_YAW_SPD  = 0.032;   // 조이스틱 좌우 = 카메라 회전 속도 (rad/frame)
const MAX_TIME     = 60_000;   // 퀴즈 제한 시간 (ms)

const GameState = Object.freeze({ READY: -1, PLAYING: 0, QUIZ: 1 });

// ── Three.js ──────────────────────────────────────────────────
const canvas3D = document.getElementById("gameCanvas");
const renderer = new THREE.WebGLRenderer({ canvas: canvas3D, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene  = new THREE.Scene();
const BG_COL = 0x060308;
scene.background = new THREE.Color(BG_COL);
scene.fog        = new THREE.Fog(BG_COL, 1, 13);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);

const mCanvas = document.getElementById("minimap");
const mCtx    = mCanvas.getContext("2d");

// ── State ─────────────────────────────────────────────────────
let maze    = [];
let visited = [];

let player = { x: 1.5, y: 1.5 };
let exit   = { x: COLS - 2.5, y: ROWS - 2.5 };
let chaser = { x: 0, y: 0 };

let pitch = 0, yaw = 0;

// 키보드 상태
const keys = {
    w: false, a: false, s: false, d: false,
    arrowup: false, arrowdown: false, arrowleft: false, arrowright: false
};

// 조이스틱 상태
const jKeys = { up: false, down: false, left: false, right: false };

let gameState       = GameState.READY;
let devModeStop     = false;
let isChaserActive  = true;
let currentUserId   = "Guest";

let currentQuestionStr = "";
let currentAnswer      = "";
let timeLeft           = MAX_TIME;
let gameStartTime      = 0;

// ✅ FIX: lastFrameTime은 update() 안에서 dt 계산에만 사용
let lastFrameTime = Date.now();

// Firebase에 저장할 통계
let quizStats    = { totalAttempted: 0, correctAnswers: 0, wrongQuestions: [] };
let keyTimeStats = { up: 0, down: 0, left: 0, right: 0 };

// 퀴즈 조이스틱 선택
let quizSelectedOption = 1;

// Three.js 오브젝트
let wallMeshes  = [];
let chaserMesh  = null;
let exitMesh    = null;
let playerLight = null;
let chaserTexture = null;

// ── DOM References ────────────────────────────────────────────
const loginPanel      = document.getElementById("login-panel");
const mathPanel       = document.getElementById("math-panel");
const instructionEl   = document.getElementById("instruction");
const questionTextEl  = document.getElementById("question-text");
const optionsTextEl   = document.getElementById("options-text");
const timerFillEl     = document.getElementById("timer-fill");
const hudTimeVal      = document.getElementById("hud-time-val");
const hudQuizVal      = document.getElementById("hud-quiz-val");
const hudPlayerVal    = document.getElementById("hud-player-val");
const joystickBadge   = document.getElementById("joystick-badge");
const joystickStatus  = document.getElementById("joystick-status");
const joystickHint    = document.getElementById("joystick-quiz-hint");
const compassArrow    = document.getElementById("compass-arrow");

// ── Login ─────────────────────────────────────────────────────
document.getElementById("startGameBtn").addEventListener("click", () => {
    const v = document.getElementById("playerIdInput").value.trim();
    if (v) { currentUserId = v; hudPlayerVal.innerText = v; }
    loginPanel.style.display = "none";
    instructionEl.classList.remove("hidden");
});

document.getElementById("playerIdInput").addEventListener("keydown", e => {
    if (e.key === "Enter") document.getElementById("startGameBtn").click();
});

// ── Pointer Lock ──────────────────────────────────────────────
document.addEventListener("click", () => {
    if (loginPanel.style.display !== "none") return;
    if (gameState === GameState.READY || gameState === GameState.PLAYING) {
        canvas3D.requestPointerLock();
    }
});

document.addEventListener("pointerlockchange", () => {
    if (document.pointerLockElement === canvas3D) {
        if (gameState === GameState.READY) {
            gameState = GameState.PLAYING;
            if (!gameStartTime) { gameStartTime = Date.now(); lastFrameTime = Date.now(); }
        }
        instructionEl.style.display = "none";
    } else {
        if (gameState === GameState.PLAYING) {
            gameState = GameState.READY;
            instructionEl.innerText = "화면을 클릭하여 계속하세요";
            instructionEl.style.display = "block";
        }
    }
});

document.addEventListener("mousemove", e => {
    if (document.pointerLockElement !== canvas3D || gameState !== GameState.PLAYING) return;
    yaw   -= e.movementX * 0.002;
    pitch -= e.movementY * 0.002;
    pitch  = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch));
    camera.rotation.set(pitch, yaw, 0, "YXZ");
});

window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// ── Keyboard Input ────────────────────────────────────────────
window.addEventListener("keydown", e => {
    // Ctrl+F → 개발자 모드 (추격자 정지)
    if (e.ctrlKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        devModeStop = !devModeStop;
        console.log(devModeStop ? "🛠️ 추격자 정지" : "🛠️ 추격자 재개");
        return;
    }
    const k = e.key.toLowerCase();
    if (k in keys) keys[k] = true;

    // 퀴즈 숫자키 입력
    if (gameState === GameState.QUIZ && "12345".includes(e.key) && e.key.length === 1) {
        submitAnswer(e.key);
    }
});

window.addEventListener("keyup", e => {
    const k = e.key.toLowerCase();
    if (k in keys) keys[k] = false;
});

// ── Answer Submission ─────────────────────────────────────────
function submitAnswer(chosen) {
    if (gameState !== GameState.QUIZ) return;
    quizStats.totalAttempted++;

    if (chosen === currentAnswer) {
        // ✅ 정답
        quizStats.correctAnswers++;
        questionTextEl.innerText = "✅ 정답! 추적자가 3초 후 재배치됩니다.";
        optionsTextEl.innerHTML  = "";

        setTimeout(() => {
            mathPanel.classList.add("hidden");
            gameState = GameState.READY;
            instructionEl.innerText = "화면을 클릭하여 계속하세요";
            instructionEl.style.display = "block";
        }, 1000);

        isChaserActive = false;
        if (chaserMesh) chaserMesh.visible = false;
        setTimeout(() => spawnChaserRandomly(), 3000);

    } else {
        // ✅ FIX: 오답 시 wrongQuestions에 push
        quizStats.wrongQuestions.push(currentQuestionStr);
        alert(`❌ 오답! 정답은 ${currentAnswer}번이었습니다.\n잡아먹혔습니다.`);
        resetGame();
    }
}

// expose for onclick in options
window._submitAnswer = submitAnswer;

// ── Web Serial / Joystick ─────────────────────────────────────
let serialBuffer = "";

document.getElementById("joystickBtn").addEventListener("click", async () => {
    if (!("serial" in navigator)) {
        joystickStatus.innerText = "⚠️ 브라우저가 Web Serial API를 지원하지 않습니다 (Chrome 권장).";
        return;
    }
    try {
        joystickStatus.innerText = "포트를 선택하세요...";
        const port = await navigator.serial.requestPort();
        await port.open({ baudRate: 115200 });

        joystickStatus.innerText = "✅ 연결됨";
        document.getElementById("joystickBtn").classList.add("connected");
        joystickBadge.classList.remove("hidden");
        joystickHint.classList.remove("hidden");

        readSerialLoop(port);
    } catch (e) {
        joystickStatus.innerText = "연결 취소 또는 실패: " + e.message;
    }
});

async function readSerialLoop(port) {
    const decoder = new TextDecoderStream();
    port.readable.pipeTo(decoder.writable);
    const reader = decoder.readable.getReader();
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            serialBuffer += value;
            const lines = serialBuffer.split("\n");
            serialBuffer = lines.pop();          // 마지막 불완전 라인은 버퍼에 유지
            for (const line of lines) handleJoystickLine(line.trim());
        }
    } catch (e) {
        console.error("Serial 읽기 오류:", e);
        joystickStatus.innerText = "⚠️ 연결 끊김";
        document.getElementById("joystickBtn").classList.remove("connected");
        joystickBadge.classList.add("hidden");
        // 모든 조이스틱 키 해제
        jKeys.up = jKeys.down = jKeys.left = jKeys.right = false;
    }
}

/**
 * MOVE:UP / MOVE:DOWN / MOVE:LEFT / MOVE:RIGHT / MOVE:NEUTRAL
 * ACTION:SHOOT
 *
 * 게임 중:  UP/DOWN = 전후 이동, LEFT/RIGHT = 카메라 좌우 회전
 * 퀴즈 중:  UP/DOWN = 보기 선택, ACTION = 제출
 * READY 중: ACTION = 포인터 락 (게임 시작)
 */
function handleJoystickLine(line) {
    if (line.startsWith("MOVE:")) {
        const dir = line.slice(5);
        jKeys.up    = dir === "UP";
        jKeys.down  = dir === "DOWN";
        jKeys.left  = dir === "LEFT";
        jKeys.right = dir === "RIGHT";

        // 퀴즈 모드: 보기 탐색 (방향 변경 시 1회)
        if (gameState === GameState.QUIZ) {
            if (dir === "UP"   && quizSelectedOption > 1) { quizSelectedOption--; highlightOption(); }
            if (dir === "DOWN" && quizSelectedOption < 5) { quizSelectedOption++; highlightOption(); }
        }

    } else if (line === "ACTION:SHOOT") {
        if (gameState === GameState.QUIZ) {
            submitAnswer(String(quizSelectedOption));
        } else if (gameState === GameState.READY) {
            if (document.pointerLockElement !== canvas3D) canvas3D.requestPointerLock();
        }
    }
}

function highlightOption() {
    optionsTextEl.querySelectorAll(".option-item").forEach((el, i) => {
        el.classList.toggle("selected", i + 1 === quizSelectedOption);
    });
}

// ── Language Selection ────────────────────────────────────────
function getTargetLanguage() {
    const r = Math.random() * 100;
    if (r < 35) return "Arabic (아랍어)";
    if (r < 65) return "Sanskrit (산스크리트어)";
    if (r < 80) return "English (영어)";
    if (r < 95) return "Japanese (일본어)";
    return "Korean (한국어)";
}

// ── Fetch Math Problem (Groq) ─────────────────────────────────
async function fetchMathProblem() {
    if (gameState !== GameState.QUIZ) return;

    mathPanel.classList.remove("hidden");
    questionTextEl.innerText = "🚨 심연의 감시자가 문제를 준비 중입니다...";
    optionsTextEl.innerHTML  = "";
    quizSelectedOption       = 1;
    timeLeft                 = MAX_TIME;

    const lang = getTargetLanguage();
    document.getElementById("quiz-lang-tag").innerText = `📜 ${lang}`;
    document.getElementById("quiz-counter").innerText =
        `${quizStats.totalAttempted + 1}번째 문제`;

    const prompt = `
Role: 최고 난이도 수학 문제 출제 위원.
Task: 고등학교 수능 수학 가형(미적분/기하) 오답률 90% 이상 킬러 문항(30번 수준)을 생성하라.
Language: 모든 문장과 보기는 반드시 '${lang}'로만 작성하라.
Requirements:
1. 단순 계산 아닌 심오한 추론과 개념 복합형 문제.
2. 수학 기호 정확히 사용, 오류 없을 것.
3. 정답은 1~5 보기 중 하나. 보기에 매력적인 오답 포함.

Output JSON only (no markdown backticks):
{"question":"문제","options":["1번","2번","3번","4번","5번"],"answer":"정답번호(1~5)"}`;

    try {
        const res  = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${GROQ_API_KEY}`,
                "Content-Type":  "application/json"
            },
            body: JSON.stringify({
                model:           "llama-3.3-70b-versatile",
                messages:        [{ role: "user", content: prompt }],
                response_format: { type: "json_object" }
            })
        });
        const data = await res.json();
        const quiz = JSON.parse(data.choices[0].message.content);

        currentQuestionStr = quiz.question;
        currentAnswer      = String(quiz.answer).trim().replace(/[^1-5]/g, "");

        questionTextEl.innerText = quiz.question;
        optionsTextEl.innerHTML  = quiz.options.map((opt, i) => `
            <div class="option-item${i === 0 ? " selected" : ""}"
                 data-num="${i + 1}"
                 onclick="window._submitAnswer('${i + 1}')">
                (${i + 1}) ${opt}
            </div>`).join("");

    } catch (e) {
        questionTextEl.innerText = "심연의 연결이 끊겼습니다.\n숫자키(1~5)로 답을 입력하세요.";
        console.error("Groq API 오류:", e);
    }
}

// ── Maze Generation ───────────────────────────────────────────
function generateMaze(w, h) {
    const m = Array.from({ length: h }, () => Array(w).fill(1));
    visited  = Array.from({ length: h }, () => Array(w).fill(false));

    function carve(cx, cy) {
        m[cy][cx] = 0;
        const dirs = [[0,-2],[0,2],[-2,0],[2,0]].sort(() => Math.random() - 0.5);
        for (const [dx, dy] of dirs) {
            const nx = cx + dx, ny = cy + dy;
            if (nx >= 1 && nx < w-1 && ny >= 1 && ny < h-1 && m[ny][nx] === 1) {
                m[cy + dy/2][cx + dx/2] = 0;
                carve(nx, ny);
            }
        }
    }
    carve(1, 1);
    m[Math.floor(exit.y)][Math.floor(exit.x)] = 0;
    return m;
}

// ── Build 3-D World ───────────────────────────────────────────
function build3DWorld() {
    // 기존 벽 제거
    wallMeshes.forEach(w => scene.remove(w));
    wallMeshes = [];

    // 조명 초기화
    scene.children
        .filter(c => c.isLight)
        .forEach(l => scene.remove(l));

    scene.add(new THREE.AmbientLight(0xffffff, 0.45));

    playerLight = new THREE.PointLight(0xff7744, 1.8, 9);
    playerLight.position.set(player.x, 0.3, player.y);
    scene.add(playerLight);

    // 출구 쪽 초록빛 조명
    const exitLight = new THREE.PointLight(0x00ff88, 1.2, 6);
    exitLight.position.set(exit.x + 0.5, 0.3, exit.y + 0.5);
    scene.add(exitLight);

    // 벽
    const wallGeo = new THREE.BoxGeometry(1, 1.3, 1);
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x5a3818 });
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            if (maze[r][c] === 1) {
                const mesh = new THREE.Mesh(wallGeo, wallMat);
                mesh.position.set(c + 0.5, 0.05, r + 0.5);
                scene.add(mesh);
                wallMeshes.push(mesh);
            }
        }
    }

    // 바닥
    const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(COLS, ROWS),
        new THREE.MeshLambertMaterial({ color: 0x180e0a })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(COLS / 2, -0.5, ROWS / 2);
    scene.add(floor);

    // 천장
    const ceil = new THREE.Mesh(
        new THREE.PlaneGeometry(COLS, ROWS),
        new THREE.MeshLambertMaterial({ color: 0x0c0808 })
    );
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(COLS / 2, 0.7, ROWS / 2);
    scene.add(ceil);

    // 출구 메시
    if (!exitMesh) {
        exitMesh = new THREE.Mesh(
            new THREE.BoxGeometry(0.55, 0.55, 0.55),
            new THREE.MeshLambertMaterial({ color: 0x00ff66, emissive: 0x003322 })
        );
        scene.add(exitMesh);
    }
    exitMesh.position.set(exit.x + 0.5, 0, exit.y + 0.5);

    // 추격자 메시
    if (!chaserMesh) {
        const mat = chaserTexture
            ? new THREE.MeshBasicMaterial({ map: chaserTexture })
            : new THREE.MeshLambertMaterial({ color: 0xcc1111, emissive: 0x440000 });
        chaserMesh = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), mat);
        scene.add(chaserMesh);
    }
}

// ── Spawn Chaser at random valid position ─────────────────────
function spawnChaserRandomly() {
    let tries = 0;
    while (tries++ < 1000) {
        const tx = Math.floor(Math.random() * (COLS - 2)) + 1;
        const ty = Math.floor(Math.random() * (ROWS - 2)) + 1;
        if (maze[ty]?.[tx] !== 0) continue;
        const dist = Math.hypot((tx + 0.5) - player.x, (ty + 0.5) - player.y);
        if (dist < 5) continue;
        chaser.x = tx + 0.5;
        chaser.y = ty + 0.5;
        isChaserActive = true;
        if (chaserMesh) { chaserMesh.position.set(chaser.x, 0, chaser.y); chaserMesh.visible = true; }
        return;
    }
}

// ── Main Update Loop ──────────────────────────────────────────
function update() {
    const now = Date.now();
    // ✅ FIX: dt(프레임 간 경과 시간)를 계산 — keyTimeStats 누적에 사용
    const dt  = Math.min(now - lastFrameTime, 100); // 최대 100ms 클램프 (탭 전환 방지)
    lastFrameTime = now;

    if (gameState === GameState.PLAYING) {
        // ── 이동 입력 ────────────────────────────────────
        const goFwd   = keys.w || keys.arrowup    || jKeys.up;
        const goBwd   = keys.s || keys.arrowdown  || jKeys.down;
        const goLeft  = keys.a || keys.arrowleft;
        const goRight = keys.d || keys.arrowright;

        let dx = 0, dz = 0;
        if (goFwd)   { dx -= Math.sin(yaw) * PLAYER_SPEED; dz -= Math.cos(yaw) * PLAYER_SPEED; }
        if (goBwd)   { dx += Math.sin(yaw) * PLAYER_SPEED; dz += Math.cos(yaw) * PLAYER_SPEED; }
        if (goLeft)  { dx -= Math.cos(yaw) * PLAYER_SPEED; dz += Math.sin(yaw) * PLAYER_SPEED; }
        if (goRight) { dx += Math.cos(yaw) * PLAYER_SPEED; dz -= Math.sin(yaw) * PLAYER_SPEED; }

        // ✅ 조이스틱 좌우 = 카메라 회전 (yaw)
        if (jKeys.left)  yaw += JOY_YAW_SPD;
        if (jKeys.right) yaw -= JOY_YAW_SPD;
        if (jKeys.left || jKeys.right) camera.rotation.set(pitch, yaw, 0, "YXZ");

        // ✅ FIX: keyTimeStats에 실제 경과 시간(dt) 누적
        if (goFwd)   keyTimeStats.up    += dt;
        if (goBwd)   keyTimeStats.down  += dt;
        if (goLeft)  keyTimeStats.left  += dt;
        if (goRight) keyTimeStats.right += dt;

        // ── 충돌 + 이동 ──────────────────────────────────
        const M = 0.4;
        const py = Math.floor(player.y);
        const px = Math.floor(player.x);
        if (maze[py]?.[Math.floor(player.x + dx + Math.sign(dx) * M)] === 0) player.x += dx;
        if (maze[Math.floor(player.y + dz + Math.sign(dz) * M)]?.[px] === 0) player.y += dz;

        // 방문 기록
        const vpx = Math.floor(player.x), vpy = Math.floor(player.y);
        if (visited[vpy]) visited[vpy][vpx] = true;

        camera.position.set(player.x, 0, player.y);
        if (playerLight) playerLight.position.set(player.x, 0.3, player.y);

        // ── 추격자 이동 ──────────────────────────────────
        if (!devModeStop && isChaserActive) {
            const cdx  = player.x - chaser.x;
            const cdy  = player.y - chaser.y;
            const dist = Math.hypot(cdx, cdy);
            chaser.x += (cdx / dist) * CHASER_SPEED;
            chaser.y += (cdy / dist) * CHASER_SPEED;

            if (dist < 0.6) {
                document.exitPointerLock();
                gameState = GameState.QUIZ;
                fetchMathProblem();
            }
        }

        if (chaserMesh && isChaserActive) {
            chaserMesh.position.set(chaser.x, 0, chaser.y);
            const cdx = player.x - chaser.x, cdy = player.y - chaser.y;
            chaserMesh.rotation.x += cdy * 0.05;
            chaserMesh.rotation.z -= cdx * 0.05;
        }

        // 출구 회전 애니메이션
        if (exitMesh) exitMesh.rotation.y += 0.03;

        // ── 탈출 판정 ────────────────────────────────────
        if (Math.hypot(player.x - (exit.x + 0.5), player.y - (exit.y + 0.5)) < 0.85) {
            const clearTime = ((Date.now() - gameStartTime) / 1000).toFixed(2);
            alert(`🎉 탈출 성공!\n⏱ 클리어 시간: ${clearTime}초`);

            const moveTimes = {
                up:    (keyTimeStats.up    / 1000).toFixed(2) + "s",
                down:  (keyTimeStats.down  / 1000).toFixed(2) + "s",
                left:  (keyTimeStats.left  / 1000).toFixed(2) + "s",
                right: (keyTimeStats.right / 1000).toFixed(2) + "s"
            };

            // ✅ FIX: 실제 값이 채워진 stats를 Firebase에 저장
            saveGameStats({
                playerId:       currentUserId,
                clearTime:      parseFloat(clearTime),
                totalAttempted: quizStats.totalAttempted,
                correctAnswers: quizStats.correctAnswers,
                accuracy:       quizStats.totalAttempted > 0
                    ? ((quizStats.correctAnswers / quizStats.totalAttempted) * 100).toFixed(1) + "%"
                    : "N/A",
                wrongQuestions: quizStats.wrongQuestions,  // ✅ populated on wrong answers
                moveTimeStats:  moveTimes                  // ✅ accumulated via dt
            });

            resetGame();
            return;
        }

        // ── HUD 업데이트 ─────────────────────────────────
        if (gameStartTime) {
            const sec = Math.floor((Date.now() - gameStartTime) / 1000);
            hudTimeVal.innerText =
                String(Math.floor(sec / 60)).padStart(2, "0") + ":" +
                String(sec % 60).padStart(2, "0");
        }
        hudQuizVal.innerText = `${quizStats.correctAnswers} / ${quizStats.totalAttempted}`;

        // ── 나침반 (출구 방향) ───────────────────────────
        const ex = exit.x + 0.5, ey = exit.y + 0.5;
        const angle = Math.atan2(ex - player.x, ey - player.y) - yaw;
        compassArrow.style.transform = `rotate(${angle}rad)`;

    } else if (gameState === GameState.QUIZ) {
        // ── 퀴즈 타이머 ──────────────────────────────────
        timeLeft -= dt;
        if (timeLeft <= 0) {
            alert("⏱ 시간 초과! 잡아먹혔습니다.");
            resetGame();
            return;
        }
        if (timerFillEl) timerFillEl.style.width = (timeLeft / MAX_TIME * 100) + "%";
    }
}

// ── Minimap ───────────────────────────────────────────────────
function drawMinimap() {
    mCtx.fillStyle = "#000";
    mCtx.fillRect(0, 0, mCanvas.width, mCanvas.height);

    const sw = mCanvas.width  / COLS;
    const sh = mCanvas.height / ROWS;

    for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
            if (!visited[y]?.[x]) continue;
            mCtx.fillStyle = maze[y][x] === 1 ? "#3a2018" : "#141010";
            mCtx.fillRect(x * sw, y * sh, sw, sh);
        }
    }

    // 출구
    mCtx.fillStyle = "#00ff66";
    mCtx.fillRect(exit.x * sw, exit.y * sh, sw * 1.5, sh * 1.5);

    // 추격자
    if (isChaserActive) {
        mCtx.fillStyle = devModeStop ? "#4488ff" : "#ff2211";
        mCtx.fillRect(chaser.x * sw - 2, chaser.y * sh - 2, 4, 4);
    }

    // 플레이어
    mCtx.fillStyle = "#ffffff";
    mCtx.fillRect(player.x * sw - 2, player.y * sh - 2, 4, 4);

    // 플레이어 시선 표시
    mCtx.strokeStyle = "rgba(255,255,255,0.4)";
    mCtx.lineWidth = 1;
    mCtx.beginPath();
    mCtx.moveTo(player.x * sw, player.y * sh);
    mCtx.lineTo(player.x * sw - Math.sin(yaw) * 9, player.y * sh - Math.cos(yaw) * 9);
    mCtx.stroke();
}

// ── Reset Game ────────────────────────────────────────────────
function resetGame() {
    maze   = generateMaze(COLS, ROWS);
    player = { x: 1.5, y: 1.5 };
    chaser = { x: exit.x + 0.5, y: exit.y + 0.5 };
    pitch  = 0;
    yaw    = 0;

    gameState      = GameState.READY;
    gameStartTime  = 0;
    isChaserActive = true;
    devModeStop    = false;

    if (chaserMesh) chaserMesh.visible = true;
    mathPanel.classList.add("hidden");

    if (loginPanel.style.display === "none") {
        instructionEl.innerText = "화면을 클릭하여 진입하세요";
        instructionEl.style.display = "block";
        instructionEl.classList.remove("hidden");
    }

    // ✅ 통계 초기화
    quizStats    = { totalAttempted: 0, correctAnswers: 0, wrongQuestions: [] };
    keyTimeStats = { up: 0, down: 0, left: 0, right: 0 };
    lastFrameTime = Date.now();

    hudTimeVal.innerText   = "00:00";
    hudQuizVal.innerText   = "0 / 0";
    hudPlayerVal.innerText = currentUserId;

    build3DWorld();
    camera.position.set(player.x, 0, player.y);
    camera.rotation.set(0, 0, 0, "YXZ");
}

// ── Boot ──────────────────────────────────────────────────────
const img   = new Image();
img.src      = "image_0.png";
img.onload  = () => { chaserTexture = new THREE.CanvasTexture(img); boot(); };
img.onerror = () => { console.warn("image_0.png 없음 — 기본 색상 사용"); boot(); };

function boot() {
    resetGame();
    function loop() {
        update();
        renderer.render(scene, camera);
        drawMinimap();
        requestAnimationFrame(loop);
    }
    loop();
}
