// ─────────────────────────────────────────────────────────
// Supabase 초기화
// ─────────────────────────────────────────────────────────

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ─────────────────────────────────────────────────────────
// 상태
// ─────────────────────────────────────────────────────────

const state = {
    concepts: [],
    conceptsById: {},
    problems: [],
    problemsByConceptId: {},
    mode: 'welcome',         // welcome | dx | result | practice | history | pastResult
    user: null,              // Supabase user object
    authMode: 'login',       // login | signup
    authError: null,
    authBusy: false,
    inProgress: null,        // { current_dx, current_practice }
    sessionCount: 0,
    pastSessions: null,      // cached list when viewing history
    dx: null,
    practice: null,
    viewSession: null,
};

const DIAGNOSTIC_BATTERY = ['F04', 'F05', 'I05', 'M06', 'P01', 'P07', 'E03'];
const MAX_DX_QUESTIONS = 15;
const CIRCLED = ['①','②','③','④','⑤'];

// ─────────────────────────────────────────────────────────
// 데이터 로딩 & CSV 파싱
// ─────────────────────────────────────────────────────────

async function loadCSV(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`CSV 로딩 실패: ${url}`);
    const text = await response.text();
    return parseCSV(text);
}

function parseCSV(text) {
    const lines = text.trim().split(/\r?\n/);
    const headers = lines[0].split(',').map(h => h.trim());
    return lines.slice(1).map(line => {
        const fields = line.split(',');
        const obj = {};
        headers.forEach((h, i) => obj[h] = (fields[i] ?? '').trim());
        return obj;
    });
}

async function init() {
    try {
        state.concepts = await loadCSV('concepts.csv');
        state.concepts.forEach(c => state.conceptsById[c['개념ID']] = c);

        state.problems = await loadCSV('problems.csv');
        state.problems.forEach(p => {
            const cid = p['점검개념ID'];
            if (!state.problemsByConceptId[cid]) state.problemsByConceptId[cid] = [];
            state.problemsByConceptId[cid].push(p);
        });

        const { data } = await sb.auth.getSession();
        if (data?.session) {
            state.user = data.session.user;
            await loadUserContext();
        }

        render();
    } catch (e) {
        document.getElementById('app').innerHTML =
            `<div class="card"><h2>로딩 오류</h2><p>${escapeHTML(e.message)}</p></div>`;
    }
}

// ─────────────────────────────────────────────────────────
// 인증 (Supabase Auth)
// 학생은 "아이디 + 비밀번호" 사용. 내부에서는 가짜 이메일 형식으로 변환.
// ─────────────────────────────────────────────────────────

const FAKE_EMAIL_DOMAIN = '@math-diag.local';

function usernameToEmail(username) {
    return username.trim().toLowerCase() + FAKE_EMAIL_DOMAIN;
}

function getDisplayName() {
    return state.user?.user_metadata?.username || (state.user?.email || '').split('@')[0];
}

function setAuthMode(mode) {
    state.authMode = mode;
    state.authError = null;
    render();
}

function translateAuthError(err) {
    const msg = err?.message || String(err);
    if (msg.includes('Invalid login credentials')) return '아이디 또는 비밀번호가 올바르지 않습니다';
    if (msg.includes('User already registered')) return '이미 가입된 아이디입니다';
    if (msg.includes('Password should be at least')) return '비밀번호는 6자 이상이어야 합니다';
    if (msg.includes('Email not confirmed')) return '이메일 확인 절차가 활성되어 있어 가입이 완료되지 않았어요. 선생님께 알려주세요';
    if (msg.toLowerCase().includes('network')) return '네트워크 오류 — 연결을 확인하세요';
    return msg;
}

function validateCredentials(username, password) {
    if (!username || username.length < 3) return '아이디는 3자 이상으로 입력해주세요';
    if (!/^[a-z0-9_]+$/i.test(username)) return '아이디는 영문/숫자/_ 만 사용할 수 있어요';
    if (!password || password.length < 6) return '비밀번호는 6자 이상이어야 합니다';
    return null;
}

async function doSignup() {
    if (state.authBusy) return;
    const username = (document.getElementById('username-input')?.value || '').trim();
    const password = document.getElementById('password-input')?.value || '';
    const v = validateCredentials(username, password);
    if (v) { state.authError = v; render(); return; }

    state.authBusy = true; state.authError = null; render();

    try {
        const { data, error } = await sb.auth.signUp({
            email: usernameToEmail(username),
            password,
            options: { data: { username } },
        });
        if (error) throw error;
        if (!data.session) {
            // 이메일 확인 미완료 케이스 → 직접 로그인 시도
            const { error: e2 } = await sb.auth.signInWithPassword({
                email: usernameToEmail(username), password,
            });
            if (e2) throw e2;
        }
        const { data: s } = await sb.auth.getSession();
        state.user = s.session.user;
        await loadUserContext();
        state.authError = null;
    } catch (e) {
        state.authError = translateAuthError(e);
    } finally {
        state.authBusy = false;
        render();
    }
}

async function doLogin() {
    if (state.authBusy) return;
    const username = (document.getElementById('username-input')?.value || '').trim();
    const password = document.getElementById('password-input')?.value || '';
    if (!username || !password) {
        state.authError = '아이디와 비밀번호를 모두 입력해주세요';
        render(); return;
    }

    state.authBusy = true; state.authError = null; render();

    try {
        const { data, error } = await sb.auth.signInWithPassword({
            email: usernameToEmail(username), password,
        });
        if (error) throw error;
        state.user = data.user;
        await loadUserContext();
        state.authError = null;
    } catch (e) {
        state.authError = translateAuthError(e);
    } finally {
        state.authBusy = false;
        render();
    }
}

async function doLogout() {
    if (!confirm('로그아웃하시겠어요?')) return;
    await sb.auth.signOut();
    state.user = null;
    state.dx = null;
    state.practice = null;
    state.inProgress = null;
    state.sessionCount = 0;
    state.pastSessions = null;
    state.mode = 'welcome';
    render();
}

// ─────────────────────────────────────────────────────────
// 클라우드 저장 / 로딩
// ─────────────────────────────────────────────────────────

async function loadUserContext() {
    if (!state.user) return;
    const [ip, sc] = await Promise.all([
        sb.from('in_progress').select('current_dx, current_practice').eq('user_id', state.user.id).maybeSingle(),
        sb.from('sessions').select('id', { count: 'exact', head: true }).eq('user_id', state.user.id),
    ]);
    state.inProgress = ip.data || { current_dx: null, current_practice: null };
    state.sessionCount = sc.count || 0;
}

async function saveDxToCloud() {
    if (!state.user) return;
    const payload = state.dx ? {
        ...state.dx,
        asked: [...state.dx.asked],
        wrongConcepts: [...state.dx.wrongConcepts],
    } : null;
    await sb.from('in_progress').upsert({
        user_id: state.user.id,
        current_dx: payload,
        updated_at: new Date().toISOString(),
    });
    if (state.inProgress) state.inProgress.current_dx = payload;
}

async function savePracticeToCloud() {
    if (!state.user) return;
    const payload = state.practice ? {
        ...state.practice,
        asked: state.practice.asked ? [...state.practice.asked] : [],
    } : null;
    await sb.from('in_progress').upsert({
        user_id: state.user.id,
        current_practice: payload,
        updated_at: new Date().toISOString(),
    });
    if (state.inProgress) state.inProgress.current_practice = payload;
}

async function recordSession() {
    if (!state.user || !state.dx) return;
    const dx = state.dx;
    const { error } = await sb.from('sessions').insert({
        user_id: state.user.id,
        score: dx.history.filter(h => h.correct).length,
        total: dx.history.length,
        weak_concepts: [...dx.wrongConcepts],
        root_concepts: findRootWeaknesses(),
        history: dx.history,
    });
    if (error) console.error('세션 저장 실패', error);
    state.sessionCount += 1;
    // 진행 중 데이터 비우기
    state.dx = null;
    await saveDxToCloud();
    state.dx = dx; // 결과 화면 표시용으로 메모리 복원
}

async function fetchPastSessions() {
    if (!state.user) return [];
    const { data, error } = await sb.from('sessions')
        .select('*')
        .eq('user_id', state.user.id)
        .order('finished_at', { ascending: false });
    if (error) { console.error(error); return []; }
    return data || [];
}

// ─────────────────────────────────────────────────────────
// 보기 만들기 & 셔플
// ─────────────────────────────────────────────────────────

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function buildChoices(problem) {
    const raw = [
        { text: problem['정답'], weakness: '', isCorrect: true },
        { text: problem['오답1'], weakness: problem['약점1'], isCorrect: false },
        { text: problem['오답2'], weakness: problem['약점2'], isCorrect: false },
        { text: problem['오답3'], weakness: problem['약점3'], isCorrect: false },
        { text: problem['오답4'], weakness: problem['약점4'], isCorrect: false },
    ].filter(c => c.text);
    return shuffle(raw);
}

function getPrereqs(conceptId) {
    const c = state.conceptsById[conceptId];
    if (!c) return [];
    return (c['선수개념IDs'] || '').split(';').map(s => s.trim()).filter(Boolean);
}

function pickProblem(conceptId, opts = {}) {
    const askedDx = state.dx ? state.dx.asked : new Set();
    const askedPr = state.practice ? state.practice.asked : new Set();
    const pool = (state.problemsByConceptId[conceptId] || [])
        .filter(p => !askedDx.has(p['문제ID']) && !askedPr.has(p['문제ID']));
    if (pool.length === 0) return null;
    if (opts.diagnostic) {
        const dx = pool.find(p => p['용도'] === '진단');
        if (dx) return dx;
    }
    pool.sort((a, b) => parseInt(a['난이도']) - parseInt(b['난이도']));
    return pool[0];
}

// ─────────────────────────────────────────────────────────
// 진단 흐름
// ─────────────────────────────────────────────────────────

function startDiagnosis() {
    state.mode = 'dx';
    state.dx = {
        queue: [...DIAGNOSTIC_BATTERY],
        asked: new Set(),
        wrongConcepts: new Set(),
        history: [],
        currentProblem: null,
        currentChoices: [],
        selectedIndex: null,
        showingFeedback: false,
        lastInferred: null,
    };
    nextDxQuestion();
}

function nextDxQuestion() {
    state.dx.showingFeedback = false;
    state.dx.selectedIndex = null;
    state.dx.lastInferred = null;

    if (state.dx.history.length >= MAX_DX_QUESTIONS) {
        finishDiagnosis();
        return;
    }

    while (state.dx.queue.length > 0) {
        const conceptId = state.dx.queue.shift();
        const alreadyTested = state.dx.history.some(h => h.conceptId === conceptId);
        if (alreadyTested) continue;
        const problem = pickProblem(conceptId, { diagnostic: true });
        if (problem) {
            state.dx.currentProblem = problem;
            state.dx.currentChoices = buildChoices(problem);
            state.dx.asked.add(problem['문제ID']);
            saveDxToCloud();
            render();
            return;
        }
    }
    finishDiagnosis();
}

function selectDxChoice(idx) {
    if (state.dx.showingFeedback) return;
    state.dx.selectedIndex = idx;
    render();
}

function submitDxAnswer() {
    if (state.dx.selectedIndex === null) return;
    const problem = state.dx.currentProblem;
    const chosen = state.dx.currentChoices[state.dx.selectedIndex];
    const correct = chosen.isCorrect;

    state.dx.showingFeedback = true;

    let inferred = null;
    if (!correct) {
        inferred = chosen.weakness || problem['점검개념ID'];
        state.dx.lastInferred = inferred;
        state.dx.wrongConcepts.add(inferred);
        for (const pre of getPrereqs(inferred)) {
            const alreadyTested = state.dx.history.some(h => h.conceptId === pre);
            if (!state.dx.queue.includes(pre) && !alreadyTested) {
                state.dx.queue.push(pre);
            }
        }
    }

    state.dx.history.push({
        problemId: problem['문제ID'],
        conceptId: problem['점검개념ID'],
        question: problem['문제'],
        chosenText: chosen.text,
        correctAnswer: problem['정답'],
        correct,
        inferred,
    });

    saveDxToCloud();
    render();
}

function skipDxAnswer() {
    if (state.dx.showingFeedback) return;
    const problem = state.dx.currentProblem;
    const inferred = problem['점검개념ID'];
    state.dx.showingFeedback = true;
    state.dx.lastInferred = inferred;
    state.dx.wrongConcepts.add(inferred);
    for (const pre of getPrereqs(inferred)) {
        const alreadyTested = state.dx.history.some(h => h.conceptId === pre);
        if (!state.dx.queue.includes(pre) && !alreadyTested) {
            state.dx.queue.push(pre);
        }
    }
    state.dx.history.push({
        problemId: problem['문제ID'],
        conceptId: problem['점검개념ID'],
        question: problem['문제'],
        chosenText: '(모름)',
        correctAnswer: problem['정답'],
        correct: false,
        inferred,
    });
    saveDxToCloud();
    render();
}

async function finishDiagnosis() {
    await recordSession();
    state.mode = 'result';
    render();
}

function findRootWeaknesses() {
    const weak = state.dx.wrongConcepts;
    const roots = [];
    for (const cid of weak) {
        const prereqs = getPrereqs(cid);
        const anyWeakPrereq = prereqs.some(p => weak.has(p));
        if (!anyWeakPrereq) roots.push(cid);
    }
    return roots;
}

// ─────────────────────────────────────────────────────────
// 학습(연습) 흐름
// ─────────────────────────────────────────────────────────

function startPractice(conceptId) {
    state.mode = 'practice';
    const pool = [...(state.problemsByConceptId[conceptId] || [])];
    pool.sort((a, b) => parseInt(a['난이도']) - parseInt(b['난이도']));
    state.practice = {
        conceptId,
        queue: pool,
        asked: new Set(),
        currentProblem: null,
        currentChoices: [],
        selectedIndex: null,
        showingFeedback: false,
        correctCount: 0,
        totalCount: 0,
    };
    nextPracticeQuestion();
}

function nextPracticeQuestion() {
    state.practice.showingFeedback = false;
    state.practice.selectedIndex = null;
    const next = state.practice.queue.shift() || null;
    state.practice.currentProblem = next;
    state.practice.currentChoices = next ? buildChoices(next) : [];
    if (next) state.practice.asked.add(next['문제ID']);
    savePracticeToCloud();
    render();
}

function selectPracticeChoice(idx) {
    if (state.practice.showingFeedback) return;
    state.practice.selectedIndex = idx;
    render();
}

function submitPracticeAnswer() {
    if (state.practice.selectedIndex === null) return;
    const chosen = state.practice.currentChoices[state.practice.selectedIndex];
    state.practice.showingFeedback = true;
    state.practice.totalCount++;
    if (chosen.isCorrect) state.practice.correctCount++;
    savePracticeToCloud();
    render();
}

function backToResult() {
    state.practice = null;
    savePracticeToCloud();
    state.mode = state.dx ? 'result' : 'welcome';
    render();
}

function restart() {
    state.mode = 'welcome';
    state.dx = null;
    state.practice = null;
    state.viewSession = null;
    saveDxToCloud();
    savePracticeToCloud();
    render();
}

// ─────────────────────────────────────────────────────────
// 이어풀기 / 기록
// ─────────────────────────────────────────────────────────

function resumeProgress() {
    const ip = state.inProgress || {};
    if (ip.current_practice) {
        const pr = ip.current_practice;
        state.practice = { ...pr, asked: new Set(pr.asked || []) };
        state.mode = 'practice';
    } else if (ip.current_dx) {
        const dx = ip.current_dx;
        state.dx = { ...dx, asked: new Set(dx.asked || []), wrongConcepts: new Set(dx.wrongConcepts || []) };
        state.mode = 'dx';
    }
    render();
}

async function viewHistory() {
    state.mode = 'history';
    state.pastSessions = null;
    render();
    state.pastSessions = await fetchPastSessions();
    render();
}

function viewPastSession(sessionId) {
    if (!state.pastSessions) return;
    const sess = state.pastSessions.find(x => x.id === sessionId);
    if (!sess) return;
    state.viewSession = sess;
    state.mode = 'pastResult';
    render();
}

// ─────────────────────────────────────────────────────────
// 렌더링
// ─────────────────────────────────────────────────────────

function escapeHTML(s) {
    return (s || '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatMath(s) {
    if (!s) return '';
    let t = escapeHTML(s);
    t = t.replace(/√\(([^()]+)\)/g, '√<span class="sqrt-arg">$1</span>');
    t = t.replace(/√(\d+)/g, '√<span class="sqrt-arg">$1</span>');
    t = t.replace(/√([a-zA-Z])/g, '√<span class="sqrt-arg">$1</span>');
    t = t.replace(/\(([^()]+)\)\/\(([^()]+)\)/g,
        '<span class="frac"><span class="num">$1</span><span class="den">$2</span></span>');
    t = t.replace(/\(([^()]+)\)\/(\d+|[a-zA-Z]+)/g,
        '<span class="frac"><span class="num">$1</span><span class="den">$2</span></span>');
    t = t.replace(/(\d+|[a-zA-Z]+)\/\(([^()]+)\)/g,
        '<span class="frac"><span class="num">$1</span><span class="den">$2</span></span>');
    t = t.replace(/(\d+|[a-zA-Z]+)\/(\d+|[a-zA-Z]+)(?![\/\^])/g,
        '<span class="frac"><span class="num">$1</span><span class="den">$2</span></span>');
    return t;
}

function formatDate(iso) {
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${pad(d.getMonth()+1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function render() {
    const root = document.getElementById('app');
    if (!state.user) { root.innerHTML = renderAuth(); }
    else if (state.mode === 'welcome') root.innerHTML = renderWelcome();
    else if (state.mode === 'dx') root.innerHTML = renderDx();
    else if (state.mode === 'result') root.innerHTML = renderResult();
    else if (state.mode === 'practice') root.innerHTML = renderPractice();
    else if (state.mode === 'history') root.innerHTML = renderHistory();
    else if (state.mode === 'pastResult') root.innerHTML = renderPastResult();

    // 입력 폼 자동 포커스 + Enter 처리
    const userInput = document.getElementById('username-input');
    if (userInput && !userInput.value) userInput.focus();
    const inputs = ['username-input', 'password-input'];
    for (const id of inputs) {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('keypress', e => {
                if (e.key === 'Enter') {
                    if (state.authMode === 'signup') doSignup();
                    else doLogin();
                }
            });
        }
    }
}

// 로그인/회원가입 화면
function renderAuth() {
    const isSignup = state.authMode === 'signup';
    return `
        <div class="card auth-card">
            <h1>📘 수학 진단 학습</h1>
            <div class="auth-tabs">
                <button class="tab ${!isSignup ? 'active' : ''}" onclick="setAuthMode('login')">로그인</button>
                <button class="tab ${isSignup ? 'active' : ''}" onclick="setAuthMode('signup')">회원가입</button>
            </div>
            <input id="username-input" class="answer" placeholder="아이디 (영문/숫자, 3자 이상)"
                   autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" />
            <input id="password-input" class="answer" type="password" placeholder="비밀번호 (6자 이상)"
                   autocomplete="${isSignup ? 'new-password' : 'current-password'}" />
            ${state.authError ? `<div class="auth-error">${escapeHTML(state.authError)}</div>` : ''}
            <button class="primary block" onclick="${isSignup ? 'doSignup()' : 'doLogin()'}" ${state.authBusy ? 'disabled' : ''}>
                ${state.authBusy ? '잠시만요...' : (isSignup ? '회원가입하고 시작하기' : '로그인')}
            </button>
            <p class="meta auth-hint">
                ${isSignup
                    ? '계정이 있으면 위 "로그인" 탭으로 이동하세요.'
                    : '처음이면 위 "회원가입" 탭으로 이동하세요.'}
            </p>
        </div>
    `;
}

function renderWelcome() {
    const ip = state.inProgress || {};
    const inProgressKind = ip.current_practice ? '학습' : (ip.current_dx ? '진단' : null);
    const sessionCount = state.sessionCount || 0;

    return `
        <div class="card">
            <div class="header-row">
                <h1>📘 ${escapeHTML(getDisplayName())}님</h1>
                <button class="link-btn" onclick="doLogout()">로그아웃</button>
            </div>
            ${inProgressKind ? `
                <div class="resume-banner">진행 중인 ${inProgressKind}이 있어요.</div>
                <button class="primary block" onclick="resumeProgress()">▶ 이어풀기</button>
                <button class="block" onclick="startDiagnosis()">새 진단 시작</button>
            ` : `
                <button class="primary block" onclick="startDiagnosis()">새 진단 시작하기</button>
            `}
            ${sessionCount > 0 ? `<button class="block" onclick="viewHistory()">📋 지난 기록 보기 (${sessionCount}회)</button>` : ''}
        </div>
    `;
}

function renderChoices(choices, selectedIdx, showingFeedback, onSelectFnName) {
    return `
        <div class="choices">
            ${choices.map((c, i) => {
                let cls = 'choice';
                if (showingFeedback) {
                    cls += ' disabled';
                    if (c.isCorrect) cls += ' correct';
                    else if (i === selectedIdx) cls += ' wrong';
                } else if (i === selectedIdx) {
                    cls += ' selected';
                }
                const action = showingFeedback ? '' : `onclick="${onSelectFnName}(${i})"`;
                return `<button class="${cls}" ${action}>
                    <span class="choice-num">${CIRCLED[i]}</span>
                    <span class="choice-text">${formatMath(c.text)}</span>
                </button>`;
            }).join('')}
        </div>
    `;
}

function renderDx() {
    const dx = state.dx;
    const p = dx.currentProblem;
    const concept = state.conceptsById[p['점검개념ID']];
    const askedCount = dx.history.length + (dx.showingFeedback ? 0 : 1);
    const progress = Math.min(100, (askedCount / 10) * 100);

    if (!dx.showingFeedback) {
        return `
            <div class="card">
                <div class="progress-bar"><div class="progress-fill" style="width:${progress}%"></div></div>
                <div class="meta">진단 ${askedCount}번째 문제 · ${escapeHTML(concept['개념명'])} 점검</div>
                <div class="problem">${formatMath(p['문제'])}</div>
                ${renderChoices(dx.currentChoices, dx.selectedIndex, false, 'selectDxChoice')}
                <button class="primary block" onclick="submitDxAnswer()" ${dx.selectedIndex === null ? 'disabled' : ''}>확인</button>
                <button class="block" onclick="skipDxAnswer()">잘 모르겠어요</button>
            </div>
        `;
    } else {
        const inferred = dx.lastInferred;
        const inferredConcept = inferred ? state.conceptsById[inferred] : null;
        const isCorrect = dx.selectedIndex !== null && dx.currentChoices[dx.selectedIndex].isCorrect;
        return `
            <div class="card">
                <div class="progress-bar"><div class="progress-fill" style="width:${progress}%"></div></div>
                <div class="meta">진단 ${askedCount}번째 문제 · ${escapeHTML(concept['개념명'])} 점검</div>
                <div class="problem">${formatMath(p['문제'])}</div>
                ${renderChoices(dx.currentChoices, dx.selectedIndex, true, 'selectDxChoice')}
                ${isCorrect
                    ? `<div class="correct">✓ 정답입니다</div>`
                    : `<div class="wrong">✗ 정답은 <b>${formatMath(p['정답'])}</b></div>`}
                <div class="solution">💡 ${formatMath(p['해설'])}</div>
                ${!isCorrect && inferredConcept
                    ? `<div class="inferred">→ 짚이는 약점: <b>${escapeHTML(inferredConcept['개념명'])}</b> <span class="meta">(${inferred})</span></div>`
                    : ''}
                <button class="primary block" onclick="nextDxQuestion()">다음 문제</button>
            </div>
        `;
    }
}

function renderResult() {
    const dx = state.dx;
    if (!dx) return `<div class="card"><p>표시할 결과가 없습니다.</p><button onclick="restart()">처음으로</button></div>`;

    const weak = [...dx.wrongConcepts];
    const roots = findRootWeaknesses();
    const correctCount = dx.history.filter(h => h.correct).length;
    const total = dx.history.length;

    weak.sort((a, b) => {
        const aRoot = roots.includes(a) ? 0 : 1;
        const bRoot = roots.includes(b) ? 0 : 1;
        return aRoot - bRoot;
    });

    return `
        <div class="card">
            <h2>📊 진단 결과</h2>
            <p>점수: <b>${correctCount} / ${total}</b></p>
            <p class="meta">결과는 ${escapeHTML(getDisplayName())} 님 계정에 저장되었습니다.</p>

            ${weak.length === 0 ? `
                <p>🎉 큰 약점이 발견되지 않았어요.</p>
            ` : `
                <h3>약점 개념 (${weak.length}개)</h3>
                <ul class="weakness-list">
                    ${weak.map(cid => {
                        const c = state.conceptsById[cid];
                        if (!c) return '';
                        const isRoot = roots.includes(cid);
                        return `<li class="${isRoot ? 'root' : ''}">
                            ${isRoot ? '★ ' : ''}<b>${escapeHTML(c['개념명'])}</b>
                            <span class="meta">${cid} · ${escapeHTML(c['영역'])} · ${escapeHTML(c['학년단계'])}</span>
                        </li>`;
                    }).join('')}
                </ul>

                <h3>🌱 추천 시작 개념</h3>
                <p>아래 개념부터 학습하시면 위쪽 약점들이 함께 풀려요.</p>
                ${roots.map(cid => {
                    const c = state.conceptsById[cid];
                    if (!c) return '';
                    return `<button class="primary block" onclick="startPractice('${cid}')">▶ ${escapeHTML(c['개념명'])} 학습하기</button>`;
                }).join('')}
            `}

            ${renderHistorySection(dx.history)}

            <p style="margin-top:24px"><button class="block" onclick="restart()">처음으로</button></p>
        </div>
    `;
}

function renderHistorySection(history) {
    if (!history.length) return '';
    return `
        <h3>풀이 기록</h3>
        <div class="history">
            ${history.map(h => {
                const c = state.conceptsById[h.conceptId];
                const cName = c ? c['개념명'] : h.conceptId;
                return `<div class="history-item ${h.correct ? 'correct' : 'wrong'}">
                    <b>${h.correct ? '✓' : '✗'}</b>
                    [${h.problemId}] ${formatMath(h.question)}
                    → 내 선택: <b>${formatMath(h.chosenText)}</b>
                    ${!h.correct ? `· 정답: <b>${formatMath(h.correctAnswer)}</b>` : ''}
                    <br><span class="meta">점검: ${escapeHTML(cName)}${h.inferred && h.inferred !== h.conceptId ? ` · 짚이는 약점: ${escapeHTML(state.conceptsById[h.inferred]?.['개념명'] || h.inferred)}` : ''}</span>
                </div>`;
            }).join('')}
        </div>
    `;
}

function renderPractice() {
    const pr = state.practice;
    if (!pr) return `<div class="card"><p>학습을 시작하세요.</p><button onclick="restart()">처음으로</button></div>`;
    const concept = state.conceptsById[pr.conceptId];
    const p = pr.currentProblem;

    if (!p) {
        return `
            <div class="card">
                <h2>📚 ${escapeHTML(concept['개념명'])} 학습 완료</h2>
                <p>이 개념의 모든 문제를 풀었습니다.</p>
                <p>점수: <b>${pr.correctCount} / ${pr.totalCount}</b></p>
                <button class="primary block" onclick="backToResult()">결과 화면으로</button>
            </div>
        `;
    }

    const isCorrect = pr.showingFeedback && pr.selectedIndex !== null && pr.currentChoices[pr.selectedIndex].isCorrect;

    if (!pr.showingFeedback) {
        return `
            <div class="card">
                <div class="meta">학습 중: ${escapeHTML(concept['개념명'])} · 난이도 ${escapeHTML(p['난이도'])}</div>
                <div class="problem">${formatMath(p['문제'])}</div>
                ${renderChoices(pr.currentChoices, pr.selectedIndex, false, 'selectPracticeChoice')}
                <button class="primary block" onclick="submitPracticeAnswer()" ${pr.selectedIndex === null ? 'disabled' : ''}>확인</button>
                <button class="block" onclick="backToResult()">결과로 돌아가기</button>
            </div>
        `;
    } else {
        return `
            <div class="card">
                <div class="meta">학습 중: ${escapeHTML(concept['개념명'])} · 난이도 ${escapeHTML(p['난이도'])}</div>
                <div class="problem">${formatMath(p['문제'])}</div>
                ${renderChoices(pr.currentChoices, pr.selectedIndex, true, 'selectPracticeChoice')}
                ${isCorrect
                    ? `<div class="correct">✓ 정답입니다</div>`
                    : `<div class="wrong">✗ 정답은 <b>${formatMath(p['정답'])}</b></div>`}
                <div class="solution">💡 ${formatMath(p['해설'])}</div>
                <button class="primary block" onclick="nextPracticeQuestion()">다음 문제</button>
                <button class="block" onclick="backToResult()">결과로 돌아가기</button>
            </div>
        `;
    }
}

function renderHistory() {
    const list = state.pastSessions;
    if (list === null) {
        return `<div class="card"><p>지난 기록 불러오는 중...</p></div>`;
    }
    if (!list.length) {
        return `
            <div class="card">
                <h2>📋 지난 기록</h2>
                <p>아직 기록이 없어요.</p>
                <button class="block" onclick="restart()">처음으로</button>
            </div>
        `;
    }
    return `
        <div class="card">
            <h2>📋 지난 기록 (${list.length}회)</h2>
            <ul class="weakness-list">
                ${list.map(sess => `
                    <li onclick="viewPastSession(${sess.id})" style="cursor:pointer">
                        <b>${formatDate(sess.finished_at)}</b>
                        <span class="meta"> · 점수 ${sess.score}/${sess.total} · 약점 ${(sess.weak_concepts || []).length}개</span>
                    </li>
                `).join('')}
            </ul>
            <button class="block" onclick="restart()">처음으로</button>
        </div>
    `;
}

function renderPastResult() {
    const sess = state.viewSession;
    if (!sess) return '<div class="card"><p>세션을 찾을 수 없어요.</p><button onclick="viewHistory()">목록으로</button></div>';
    const weak = sess.weak_concepts || [];
    const roots = sess.root_concepts || [];
    return `
        <div class="card">
            <h2>📊 ${formatDate(sess.finished_at)} 진단</h2>
            <p>점수: <b>${sess.score} / ${sess.total}</b></p>
            ${weak.length === 0 ? '<p>큰 약점이 없었어요.</p>' : `
                <h3>약점 개념 (${weak.length}개)</h3>
                <ul class="weakness-list">
                    ${weak.map(cid => {
                        const c = state.conceptsById[cid];
                        if (!c) return `<li><span class="meta">${cid}</span></li>`;
                        const isRoot = roots.includes(cid);
                        return `<li class="${isRoot ? 'root' : ''}">
                            ${isRoot ? '★ ' : ''}<b>${escapeHTML(c['개념명'])}</b>
                            <span class="meta">${cid}</span>
                        </li>`;
                    }).join('')}
                </ul>
            `}
            ${renderHistorySection(sess.history || [])}
            <p style="margin-top:24px">
                <button class="block" onclick="viewHistory()">기록 목록으로</button>
                <button class="block" onclick="restart()">처음으로</button>
            </p>
        </div>
    `;
}

window.addEventListener('DOMContentLoaded', init);
