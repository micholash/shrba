// ═══════════════════════════════════════════════════════════════
//  game.js  ·  심연 미로
//  - Firebase Compat 전역 객체 사용 (import 없음)
//  - 일반 <script> 태그로 로드 (type="module" 아님)
//  - keyTimeStats dt 누적 수정
//  - wrongQuestions push 수정
//  - 조이스틱 Web Serial 지원
// ═══════════════════════════════════════════════════════════════

// ── Firebase (compat 전역) ────────────────────────────────────
var fbApp, fbDb;
try {
    fbApp = firebase.initializeApp({
        apiKey:            "AIzaSyA7kuCSB9UsaCtOYIhsQGuil0-g5rIh_Fs",
        authDomain:        "bloodborne-b1aae.firebaseapp.com",
        databaseURL:       "https://bloodborne-b1aae-default-rtdb.asia-southeast1.firebasedatabase.app",
        projectId:         "bloodborne-b1aae",
        storageBucket:     "bloodborne-b1aae.firebasestorage.app",
        messagingSenderId: "415284045901",
        appId:             "1:415284045901:web:ec45dcb66a955811c45404"
    });
    fbDb = firebase.database(fbApp);
    console.log("✅ Firebase 초기화 완료");
} catch(e) {
    console.warn("⚠️ Firebase 초기화 실패 (데이터 저장 불가):", e.message);
}

function saveGameStats(stats) {
    if (!fbDb) { console.warn("Firebase 없음, 저장 스킵"); return; }
    fbDb.ref("game_clears").push({ ...stats, serverTimestamp: new Date().toISOString() })
        .then(function() { console.log("✅ Firebase game_clears 저장 완료", stats); })
        .catch(function(e) { console.error("❌ Firebase 저장 실패:", e); });
}


// ── Groq API Key ──────────────────────────────────────────────
var GROQ_API_KEY = "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";

// ── Constants ─────────────────────────────────────────────────
var COLS         = 32;
var ROWS         = 20;
var PLAYER_SPEED = 0.07;
var CHASER_SPEED = PLAYER_SPEED * 1.05;
var JOY_YAW_SPD  = 0.032;
var MAX_TIME     = 60000;

var GameState = { READY: -1, PLAYING: 0, QUIZ: 1 };

// ── Three.js ──────────────────────────────────────────────────
var canvas3D = document.getElementById("gameCanvas");
var renderer = new THREE.WebGLRenderer({ canvas: canvas3D, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

var scene    = new THREE.Scene();
var BG_COL   = 0x060308;
scene.background = new THREE.Color(BG_COL);
scene.fog        = new THREE.Fog(BG_COL, 1, 13);

var camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);

var mCanvas = document.getElementById("minimap");
var mCtx    = mCanvas.getContext("2d");

// ── State ─────────────────────────────────────────────────────
var maze    = [];
var visited = [];

var player = { x: 1.5, y: 1.5 };
var exit   = { x: COLS - 2.5, y: ROWS - 2.5 };
var chaser = { x: 0, y: 0 };

var pitch = 0, yaw = 0;

var keys = {
    w: false, a: false, s: false, d: false,
    arrowup: false, arrowdown: false, arrowleft: false, arrowright: false
};
var jKeys = { up: false, down: false, left: false, right: false };

var gameState      = GameState.READY;
var devModeStop    = false;
var isChaserActive = true;
var currentUserId  = "Guest";

var currentQuestionStr = "";
var currentAnswer      = "";
var currentOptions     = []; 
var timeLeft           = MAX_TIME;
var gameStartTime      = 0;
var lastFrameTime      = Date.now();

var quizStats        = { totalAttempted: 0, correctAnswers: 0, wrongQuestions: [] };
var sessionWrongLog  = []; // ✅ resetGame()에도 초기화 안 됨
var sessionTotalAttempted  = 0;
var sessionCorrectAnswers  = 0;
var keyTimeStats = { up: 0, down: 0, left: 0, right: 0 };
var quizSelectedOption = 1;

var wallMeshes    = [];
var chaserMesh    = null;
var exitMesh      = null;
var playerLight   = null;
var chaserTexture = null;

// ── DOM ───────────────────────────────────────────────────────
var loginPanel     = document.getElementById("login-panel");
var mathPanel      = document.getElementById("math-panel");
var instructionEl  = document.getElementById("instruction");
var questionTextEl = document.getElementById("question-text");
var optionsTextEl  = document.getElementById("options-text");
var timerFillEl    = document.getElementById("timer-fill");
var hudTimeVal     = document.getElementById("hud-time-val");
var hudQuizVal     = document.getElementById("hud-quiz-val");
var hudPlayerVal   = document.getElementById("hud-player-val");
var joystickBadge  = document.getElementById("joystick-badge");
var joystickStatus = document.getElementById("joystick-status");
var joystickHint   = document.getElementById("joystick-quiz-hint");
var compassArrow   = document.getElementById("compass-arrow");

// ── Login ─────────────────────────────────────────────────────
document.getElementById("startGameBtn").addEventListener("click", function() {
    var v = document.getElementById("playerIdInput").value.trim();
    if (v) { currentUserId = v; hudPlayerVal.innerText = v; }
    loginPanel.style.display = "none";
    instructionEl.classList.remove("hidden");
    console.log("게임 시작 준비 완료 — 화면 클릭으로 진입");
});

document.getElementById("playerIdInput").addEventListener("keydown", function(e) {
    if (e.key === "Enter") document.getElementById("startGameBtn").click();
});

// ── Pointer Lock ──────────────────────────────────────────────
document.addEventListener("click", function() {
    if (loginPanel.style.display !== "none") return;
    if (gameState === GameState.READY || gameState === GameState.PLAYING) {
        canvas3D.requestPointerLock();
    }
});

document.addEventListener("pointerlockchange", function() {
    if (document.pointerLockElement === canvas3D) {
        if (gameState === GameState.READY) {
            gameState = GameState.PLAYING;
            if (!gameStartTime) {
                gameStartTime = Date.now();
                lastFrameTime = Date.now();
            }
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

document.addEventListener("mousemove", function(e) {
    if (document.pointerLockElement !== canvas3D || gameState !== GameState.PLAYING) return;
    yaw   -= e.movementX * 0.002;
    pitch -= e.movementY * 0.002;
    pitch  = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch));
    camera.rotation.set(pitch, yaw, 0, "YXZ");
});

window.addEventListener("resize", function() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// ── Keyboard ──────────────────────────────────────────────────
window.addEventListener("keydown", function(e) {
    if (e.ctrlKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        devModeStop = !devModeStop;
        console.log(devModeStop ? "🛠️ 추격자 정지" : "🛠️ 추격자 재개");
        return;
    }
    var k = e.key.toLowerCase();
    if (k in keys) keys[k] = true;
    if (gameState === GameState.QUIZ && "12345".indexOf(e.key) !== -1 && e.key.length === 1) {
        submitAnswer(e.key);
    }
});

window.addEventListener("keyup", function(e) {
    var k = e.key.toLowerCase();
    if (k in keys) keys[k] = false;
});

// ── Answer Submission ─────────────────────────────────────────
function submitAnswer(chosen) {
    if (gameState !== GameState.QUIZ) return;
    quizStats.totalAttempted++;
    sessionTotalAttempted++; // ✅

    if (chosen === currentAnswer) {
        quizStats.correctAnswers++;
        sessionCorrectAnswers++; // ✅
        questionTextEl.innerText = "✅ 정답! 추적자가 3초 후 재배치됩니다.";
        optionsTextEl.innerHTML  = "";
        setTimeout(function() {
            mathPanel.classList.add("hidden");
            gameState = GameState.READY;
            instructionEl.innerText = "화면을 클릭하여 계속하세요";
            instructionEl.style.display = "block";
        }, 1000);
        isChaserActive = false;
        if (chaserMesh) chaserMesh.visible = false;
        setTimeout(function() { spawnChaserRandomly(); }, 3000);
    } else {
        var wrongEntry = {
    question:      currentQuestionStr,
    options:       currentOptions,      // ✅ 선지 추가
    chosenAnswer:  chosen,
    correctAnswer: currentAnswer
};
        quizStats.wrongQuestions.push(wrongEntry);
        sessionWrongLog.push(wrongEntry); // ✅ 세션 누적
        alert("❌ 오답! 정답은 " + currentAnswer + "번이었습니다.\n잡아먹혔습니다.");
        resetGame();
    }
}

// onclick에서 호출하기 위해 전역 노출
window._submitAnswer = submitAnswer;

// ── Web Serial / Joystick ─────────────────────────────────────
var serialBuffer = "";

document.getElementById("joystickBtn").addEventListener("click", async function() {
    if (!("serial" in navigator)) {
        joystickStatus.innerText = "⚠️ Web Serial 미지원 브라우저입니다 (Chrome 권장).";
        return;
    }
    try {
        joystickStatus.innerText = "포트를 선택하세요...";
        var port = await navigator.serial.requestPort();
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
    var decoder = new TextDecoderStream();
    port.readable.pipeTo(decoder.writable);
    var reader = decoder.readable.getReader();
    try {
        while (true) {
            var result = await reader.read();
            if (result.done) break;
            serialBuffer += result.value;
            var lines = serialBuffer.split("\n");
            serialBuffer = lines.pop();
            for (var i = 0; i < lines.length; i++) {
                handleJoystickLine(lines[i].trim());
            }
        }
    } catch (e) {
        console.error("Serial 오류:", e);
        joystickStatus.innerText = "⚠️ 연결 끊김";
        document.getElementById("joystickBtn").classList.remove("connected");
        joystickBadge.classList.add("hidden");
        jKeys.up = jKeys.down = jKeys.left = jKeys.right = false;
    }
}

function handleJoystickLine(line) {
    if (line.indexOf("MOVE:") === 0) {
        var dir = line.slice(5);
        jKeys.up    = (dir === "UP");
        jKeys.down  = (dir === "DOWN");
        jKeys.left  = (dir === "LEFT");
        jKeys.right = (dir === "RIGHT");

        // 퀴즈 중 보기 탐색 (방향 변화 1회에 1칸)
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
    var items = optionsTextEl.querySelectorAll(".option-item");
    for (var i = 0; i < items.length; i++) {
        items[i].classList.toggle("selected", i + 1 === quizSelectedOption);
    }
}

// ── Language ──────────────────────────────────────────────────
function getTargetLanguage() {
    var r = Math.random() * 100;
    if (r < 35) return "Arabic (아랍어)";
    if (r < 65) return "Sanskrit (산스크리트어)";
    if (r < 80) return "English (영어)";
    if (r < 95) return "Japanese (일본어)";
    return "Korean (한국어)";
}

// ── Fetch Quiz from Groq ──────────────────────────────────────
function fetchMathProblem() {
    if (gameState !== GameState.QUIZ) return;
    mathPanel.classList.remove("hidden");
    questionTextEl.innerText = "🚨 심연의 감시자가 문제를 준비 중입니다...";
    optionsTextEl.innerHTML  = "";
    quizSelectedOption       = 1;
    timeLeft                 = MAX_TIME;

    var lang = getTargetLanguage();
    document.getElementById("quiz-lang-tag").innerText  = "📜 " + lang;
    document.getElementById("quiz-counter").innerText   = (quizStats.totalAttempted + 1) + "번째 문제";

    var prompt = "Role: 최고 난이도 수학 문제 출제 위원.\n"
        + "Task: 고등학교 수능 수학 가형(미적분/기하) 오답률 90% 이상 킬러 문항(30번 수준)을 생성하라.\n"
        + "Language: 모든 문장과 보기는 반드시 '" + lang + "'로만 작성하라.\n"
        + "Requirements:\n"
        + "1. 단순 계산 아닌 심오한 추론과 개념 복합형 문제.\n"
        + "2. 수학 기호 정확히 사용, 오류 없을 것.\n"
        + "3. 정답은 1~5 보기 중 하나. 보기에 매력적인 오답 포함.\n"
        + "Output JSON only (no markdown backticks):\n"
        + '{"question":"문제","options":["1번","2번","3번","4번","5번"],"answer":"정답번호(1~5)"}';

    fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": "Bearer " + GROQ_API_KEY,
            "Content-Type":  "application/json"
        },
        body: JSON.stringify({
            model:           "llama-3.3-70b-versatile",
            messages:        [{ role: "user", content: prompt }],
            response_format: { type: "json_object" }
        })
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
        var quiz = JSON.parse(data.choices[0].message.content);
        currentQuestionStr = quiz.question;
        currentAnswer      = String(quiz.answer).trim().replace(/[^1-5]/g, "");
        currentOptions     = quiz.options;  // ✅ 추가
        questionTextEl.innerText = quiz.question;
        optionsTextEl.innerHTML  = quiz.options.map(function(opt, i) {
            return '<div class="option-item' + (i === 0 ? ' selected' : '') + '"'
                + ' data-num="' + (i+1) + '"'
                + ' onclick="window._submitAnswer(\'' + (i+1) + '\')">'
                + '(' + (i+1) + ') ' + opt + '</div>';
        }).join("");
    })
    .catch(function(e) {
        questionTextEl.innerText = "심연의 연결이 끊겼습니다.\n숫자키(1~5)로 답을 입력하세요.";
        console.error("Groq API 오류:", e);
    });
}

// ── Maze Generation ───────────────────────────────────────────
function generateMaze(w, h) {
    var m = [];
    var r, c;
    for (r = 0; r < h; r++) {
        m[r] = [];
        for (c = 0; c < w; c++) m[r][c] = 1;
    }
    visited = [];
    for (r = 0; r < h; r++) {
        visited[r] = [];
        for (c = 0; c < w; c++) visited[r][c] = false;
    }

    function carve(cx, cy) {
        m[cy][cx] = 0;
        var dirs = [[0,-2],[0,2],[-2,0],[2,0]].sort(function() { return Math.random() - 0.5; });
        for (var i = 0; i < dirs.length; i++) {
            var dx = dirs[i][0], dy = dirs[i][1];
            var nx = cx + dx, ny = cy + dy;
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
    for (var i = 0; i < wallMeshes.length; i++) scene.remove(wallMeshes[i]);
    wallMeshes = [];

    // 조명 제거 후 재생성
    var toRemove = [];
    for (var j = 0; j < scene.children.length; j++) {
        if (scene.children[j].isLight) toRemove.push(scene.children[j]);
    }
    for (var k = 0; k < toRemove.length; k++) scene.remove(toRemove[k]);

    scene.add(new THREE.AmbientLight(0xffffff, 0.45));
    playerLight = new THREE.PointLight(0xff7744, 1.8, 9);
    playerLight.position.set(player.x, 0.3, player.y);
    scene.add(playerLight);

    var exitLight = new THREE.PointLight(0x00ff88, 1.2, 6);
    exitLight.position.set(exit.x + 0.5, 0.3, exit.y + 0.5);
    scene.add(exitLight);

    var wallGeo = new THREE.BoxGeometry(1, 1.3, 1);
    var wallMat = new THREE.MeshLambertMaterial({ color: 0x5a3818 });
    for (var row = 0; row < ROWS; row++) {
        for (var col = 0; col < COLS; col++) {
            if (maze[row][col] === 1) {
                var mesh = new THREE.Mesh(wallGeo, wallMat);
                mesh.position.set(col + 0.5, 0.05, row + 0.5);
                scene.add(mesh);
                wallMeshes.push(mesh);
            }
        }
    }

    var floor = new THREE.Mesh(
        new THREE.PlaneGeometry(COLS, ROWS),
        new THREE.MeshLambertMaterial({ color: 0x180e0a })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(COLS/2, -0.5, ROWS/2);
    scene.add(floor);

    var ceil = new THREE.Mesh(
        new THREE.PlaneGeometry(COLS, ROWS),
        new THREE.MeshLambertMaterial({ color: 0x0c0808 })
    );
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(COLS/2, 0.7, ROWS/2);
    scene.add(ceil);

    if (!exitMesh) {
        exitMesh = new THREE.Mesh(
            new THREE.BoxGeometry(0.55, 0.55, 0.55),
            new THREE.MeshLambertMaterial({ color: 0x00ff66, emissive: 0x003322 })
        );
        scene.add(exitMesh);
    }
    exitMesh.position.set(exit.x + 0.5, 0, exit.y + 0.5);

    if (!chaserMesh) {
        var mat = chaserTexture
            ? new THREE.MeshBasicMaterial({ map: chaserTexture })
            : new THREE.MeshLambertMaterial({ color: 0xcc1111, emissive: 0x440000 });
        chaserMesh = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), mat);
        scene.add(chaserMesh);
    }
}

// ── Spawn Chaser ──────────────────────────────────────────────
function spawnChaserRandomly() {
    var tries = 0;
    while (tries++ < 2000) {
        var tx = Math.floor(Math.random() * (COLS - 2)) + 1;
        var ty = Math.floor(Math.random() * (ROWS - 2)) + 1;
        if (!maze[ty] || maze[ty][tx] !== 0) continue;
        var dist = Math.hypot((tx + 0.5) - player.x, (ty + 0.5) - player.y);
        if (dist < 5) continue;
        chaser.x = tx + 0.5;
        chaser.y = ty + 0.5;
        isChaserActive = true;
        if (chaserMesh) {
            chaserMesh.position.set(chaser.x, 0, chaser.y);
            chaserMesh.visible = true;
        }
        return;
    }
}

// ── Update (main loop) ────────────────────────────────────────
function update() {
    var now = Date.now();
    // ✅ FIX: 실제 프레임 간격(dt)으로 이동 시간 누적
    var dt  = Math.min(now - lastFrameTime, 100);
    lastFrameTime = now;

    if (gameState === GameState.PLAYING) {
        var goFwd   = keys.w || keys.arrowup    || jKeys.up;
        var goBwd   = keys.s || keys.arrowdown  || jKeys.down;
        var goLeft  = keys.a || keys.arrowleft;
        var goRight = keys.d || keys.arrowright;

        var dx = 0, dz = 0;
        if (goFwd)   { dx -= Math.sin(yaw) * PLAYER_SPEED; dz -= Math.cos(yaw) * PLAYER_SPEED; }
        if (goBwd)   { dx += Math.sin(yaw) * PLAYER_SPEED; dz += Math.cos(yaw) * PLAYER_SPEED; }
        if (goLeft)  { dx -= Math.cos(yaw) * PLAYER_SPEED; dz += Math.sin(yaw) * PLAYER_SPEED; }
        if (goRight) { dx += Math.cos(yaw) * PLAYER_SPEED; dz -= Math.sin(yaw) * PLAYER_SPEED; }

        // 조이스틱 좌우 = 카메라 회전
        if (jKeys.left)  yaw += JOY_YAW_SPD;
        if (jKeys.right) yaw -= JOY_YAW_SPD;
        if (jKeys.left || jKeys.right) camera.rotation.set(pitch, yaw, 0, "YXZ");

        // ✅ FIX: dt를 사용해 실제 이동 시간 누적
        if (goFwd)   keyTimeStats.up    += dt;
        if (goBwd)   keyTimeStats.down  += dt;
        if (goLeft)  keyTimeStats.left  += dt;
        if (goRight) keyTimeStats.right += dt;

        // 충돌
        var M  = 0.4;
        var py = Math.floor(player.y);
        var px = Math.floor(player.x);
        if (maze[py] && maze[py][Math.floor(player.x + dx + (dx > 0 ? M : -M))] === 0) player.x += dx;
        if (maze[Math.floor(player.y + dz + (dz > 0 ? M : -M))] &&
            maze[Math.floor(player.y + dz + (dz > 0 ? M : -M))][px] === 0) player.y += dz;

        var vpx = Math.floor(player.x), vpy = Math.floor(player.y);
        if (visited[vpy]) visited[vpy][vpx] = true;
        camera.position.set(player.x, 0, player.y);
        if (playerLight) playerLight.position.set(player.x, 0.3, player.y);

        // 추격자 이동
        if (!devModeStop && isChaserActive) {
            var cdx  = player.x - chaser.x;
            var cdy  = player.y - chaser.y;
            var dist = Math.hypot(cdx, cdy);
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
            var cx2 = player.x - chaser.x, cy2 = player.y - chaser.y;
            chaserMesh.rotation.x += cy2 * 0.05;
            chaserMesh.rotation.z -= cx2 * 0.05;
        }
        if (exitMesh) exitMesh.rotation.y += 0.03;

        // 탈출 판정
        if (Math.hypot(player.x - (exit.x + 0.5), player.y - (exit.y + 0.5)) < 0.85) {
    var clearTime = ((Date.now() - gameStartTime) / 1000).toFixed(2);

    var totalWrong = sessionWrongLog.length;
    var totalRight = sessionCorrectAnswers;
    var totalTried = sessionTotalAttempted;

    var statsSnapshot = {
        playerId:  currentUserId,
        clearTime: parseFloat(clearTime),
        quizSummary: {
            totalAttempted: totalTried,
            correctAnswers: totalRight,
            wrongAnswers:   totalWrong,
            accuracy:       totalTried > 0
                ? ((totalRight / totalTried) * 100).toFixed(1) + "%"
                : "N/A"
        },
        wrongNotes: sessionWrongLog.map(function(w) { // ✅ 오답 전체 전송
            return {
                question:      w.question,
                options:       w.options,
                chosenAnswer:  w.chosenAnswer,
                correctAnswer: w.correctAnswer
            };
        }),
        moveTimeStats: {
            up:    (keyTimeStats.up    / 1000).toFixed(2) + "s",
            down:  (keyTimeStats.down  / 1000).toFixed(2) + "s",
            left:  (keyTimeStats.left  / 1000).toFixed(2) + "s",
            right: (keyTimeStats.right / 1000).toFixed(2) + "s"
        }
    };

    alert("🎉 탈출 성공!\n⏱ 클리어 시간: " + clearTime + "초");
    saveGameStats(statsSnapshot);
    resetGame();
    return;
}

        // HUD
        if (gameStartTime) {
            var sec = Math.floor((Date.now() - gameStartTime) / 1000);
            hudTimeVal.innerText =
                String(Math.floor(sec / 60)).padStart(2, "0") + ":" +
                String(sec % 60).padStart(2, "0");
        }
        hudQuizVal.innerText = quizStats.correctAnswers + " / " + quizStats.totalAttempted;

        // 나침반
        var ex = exit.x + 0.5, ey = exit.y + 0.5;
        var angle = Math.atan2(ex - player.x, ey - player.y) - yaw;
        compassArrow.style.transform = "rotate(" + angle + "rad)";

    } else if (gameState === GameState.QUIZ) {
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
    var sw = mCanvas.width  / COLS;
    var sh = mCanvas.height / ROWS;
    for (var y = 0; y < ROWS; y++) {
        for (var x = 0; x < COLS; x++) {
            if (!visited[y] || !visited[y][x]) continue;
            mCtx.fillStyle = maze[y][x] === 1 ? "#3a2018" : "#141010";
            mCtx.fillRect(x * sw, y * sh, sw, sh);
        }
    }
    mCtx.fillStyle = "#00ff66";
    mCtx.fillRect(exit.x * sw, exit.y * sh, sw * 1.5, sh * 1.5);
    if (isChaserActive) {
        mCtx.fillStyle = devModeStop ? "#4488ff" : "#ff2211";
        mCtx.fillRect(chaser.x * sw - 2, chaser.y * sh - 2, 4, 4);
    }
    mCtx.fillStyle = "#ffffff";
    mCtx.fillRect(player.x * sw - 2, player.y * sh - 2, 4, 4);
    mCtx.strokeStyle = "rgba(255,255,255,0.4)";
    mCtx.lineWidth = 1;
    mCtx.beginPath();
    mCtx.moveTo(player.x * sw, player.y * sh);
    mCtx.lineTo(player.x * sw - Math.sin(yaw) * 9, player.y * sh - Math.cos(yaw) * 9);
    mCtx.stroke();
}

// ── Reset ─────────────────────────────────────────────────────
function resetGame() {
    maze   = generateMaze(COLS, ROWS);
    player = { x: 1.5, y: 1.5 };
    chaser = { x: exit.x + 0.5, y: exit.y + 0.5 };
    pitch  = 0; yaw = 0;

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
var img   = new Image();
img.src   = "image_0.png";
img.onload = function() {
    chaserTexture = new THREE.CanvasTexture(img);
    bootGame();
};
img.onerror = function() {
    console.warn("image_0.png 없음 — 기본 색상 사용");
    bootGame();
};

function bootGame() {
    resetGame();
    function loop() {
        update();
        renderer.render(scene, camera);
        drawMinimap();
        requestAnimationFrame(loop);
    }
    loop();
}

console.log("game.js 로드 완료 ✅");
