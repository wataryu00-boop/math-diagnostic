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
    mode: 'welcome',         // welcome | dx | result | practice | history | pastResult | teacherStudent
    user: null,              // Supabase user object
    profile: null,           // { id, username, role }
    authMode: 'login',       // login | signup
    authError: null,
    authBusy: false,
    inProgress: null,        // { current_dx, current_practice }
    sessionCount: 0,
    pastSessions: null,      // cached list when viewing history
    dx: null,
    practice: null,
    viewSession: null,
    teacherData: null,       // { students, sessions, classWeak } for teacher dashboard
    viewStudentId: null,     // when teacher drills into one student
    studyConceptId: null,    // 학생 - 개념 설명 페이지에서 보고 있는 개념
    viewConceptId: null,     // 선생님 - 개념별 문제 보기에서 선택한 개념
    mastery: null,           // { [conceptId]: { correct_streak, total_seen, total_correct, ... } }
};

// 적응형 진단 파라미터
const MASTERY_THRESHOLD = 4;          // 연속 정답 N회 = 마스터
const MASTERY_RECHECK_DAYS = 30;      // 마스터 후 N일 지나면 재검증
const MASTERY_RANDOM_RECHECK = 0.05;  // 마스터여도 무작위 재검증 확률
const STREAK_DECAY_ON_WRONG = 2;      // 오답 시 streak 감쇠량 (전체 리셋 X — 1번 실수로 약점 처리 X)
const TARGET_BATTERY_SIZE = 8;        // 동적 배터리 목표 크기

const DIAGNOSTIC_BATTERY = [
    'F04', 'F05', 'I05', 'M06', 'P01', 'P07', 'E03',  // 수와 식
    'B02', 'H03', 'G02', 'V01'                          // 부등식 / 함수 / 좌표 / 유리식
];
const MAX_DX_QUESTIONS = 18;
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
        // 프로필 생성 (실패해도 loadUserContext가 백필)
        await sb.from('profiles').upsert({ id: state.user.id, username: username.trim() });
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

// ─────────────────────────────────────────────────────────
// 관리자(선생님) 권한 전환
// ─────────────────────────────────────────────────────────

function showAdminPrompt() {
    state.mode = 'admin';
    state.authError = null;
    render();
}

function closeAdminPrompt() {
    state.mode = 'welcome';
    state.authError = null;
    render();
}

async function submitAdminPassword() {
    if (state.authBusy) return;
    const pw = document.getElementById('admin-password-input')?.value || '';
    if (!pw) {
        state.authError = '비밀번호를 입력해주세요';
        render(); return;
    }
    state.authBusy = true; state.authError = null; render();
    try {
        const { data, error } = await sb.rpc('elevate_to_teacher', { admin_password: pw });
        if (error) throw error;
        if (data === true) {
            await loadUserContext();
            state.mode = 'welcome'; // role이 teacher로 갱신되어 render()가 대시보드 렌더
        } else {
            state.authError = '비밀번호가 일치하지 않습니다';
        }
    } catch (e) {
        state.authError = translateAuthError(e);
    } finally {
        state.authBusy = false;
        render();
    }
}

function renderAdminPrompt() {
    return `
        <div class="card auth-card">
            <h1>🔑 관리자 모드 전환</h1>
            <p class="meta">관리자 비밀번호를 입력하면 선생님 권한으로 전환됩니다.</p>
            <input id="admin-password-input" class="answer" type="password"
                   placeholder="관리자 비밀번호" autocomplete="off" />
            ${state.authError ? `<div class="auth-error">${escapeHTML(state.authError)}</div>` : ''}
            <button class="primary block" onclick="submitAdminPassword()" ${state.authBusy ? 'disabled' : ''}>
                ${state.authBusy ? '확인 중...' : '확인'}
            </button>
            <button class="block" onclick="closeAdminPrompt()">취소</button>
        </div>
    `;
}

async function doLogout() {
    if (!confirm('로그아웃하시겠어요?')) return;
    await sb.auth.signOut();
    state.user = null;
    state.profile = null;
    state.dx = null;
    state.practice = null;
    state.inProgress = null;
    state.sessionCount = 0;
    state.pastSessions = null;
    state.teacherData = null;
    state.viewStudentId = null;
    state.viewSession = null;
    state.mode = 'welcome';
    render();
}

// ─────────────────────────────────────────────────────────
// 클라우드 저장 / 로딩
// ─────────────────────────────────────────────────────────

async function loadUserContext() {
    if (!state.user) return;

    // 프로필 로드 (없으면 생성: profiles 테이블 도입 전 가입자 대응)
    let { data: profile } = await sb.from('profiles')
        .select('*').eq('id', state.user.id).maybeSingle();
    if (!profile) {
        const username = state.user.user_metadata?.username
            || (state.user.email || '').split('@')[0];
        const { data: created } = await sb.from('profiles')
            .insert({ id: state.user.id, username }).select().single();
        profile = created;
    }
    state.profile = profile;

    if (profile?.role === 'teacher') {
        await loadTeacherData();
        state.inProgress = null;
        state.sessionCount = 0;
    } else {
        const [ip, sc, masteryRes] = await Promise.all([
            sb.from('in_progress').select('current_dx, current_practice').eq('user_id', state.user.id).maybeSingle(),
            sb.from('sessions').select('id', { count: 'exact', head: true }).eq('user_id', state.user.id),
            sb.from('concept_mastery').select('*').eq('user_id', state.user.id),
        ]);
        state.inProgress = ip.data || { current_dx: null, current_practice: null };
        state.sessionCount = sc.count || 0;
        state.teacherData = null;

        // mastery: { conceptId: row } 맵
        const mm = {};
        for (const m of (masteryRes.data || [])) mm[m.concept_id] = m;
        state.mastery = mm;
    }
}

async function loadTeacherData() {
    const [profilesResult, sessionsResult, masteryResult] = await Promise.all([
        sb.from('profiles').select('*'),
        sb.from('sessions').select('*').order('finished_at', { ascending: false }),
        sb.from('concept_mastery').select('*'),
    ]);
    const allProfiles = profilesResult.data || [];
    const sessions = sessionsResult.data || [];

    // 학생별 mastery 맵: { user_id: { concept_id: row } }
    const masteryByUser = {};
    for (const m of (masteryResult.data || [])) {
        if (!masteryByUser[m.user_id]) masteryByUser[m.user_id] = {};
        masteryByUser[m.user_id][m.concept_id] = m;
    }

    const profileById = {};
    for (const p of allProfiles) profileById[p.id] = p;

    const students = allProfiles.filter(p => p.role === 'student');

    // 학생별 집계
    const sessionsByUser = new Map();
    for (const s of sessions) {
        if (!sessionsByUser.has(s.user_id)) sessionsByUser.set(s.user_id, []);
        sessionsByUser.get(s.user_id).push(s);
    }
    const studentList = students.map(p => {
        const userSessions = sessionsByUser.get(p.id) || [];
        const allWeak = userSessions.flatMap(s => s.weak_concepts || []);
        return {
            ...p,
            sessionCount: userSessions.length,
            lastSession: userSessions[0] || null,
            uniqueWeakCount: new Set(allWeak).size,
        };
    }).sort((a, b) => {
        // 최근 진단 본 학생 먼저
        const at = a.lastSession ? new Date(a.lastSession.finished_at).getTime() : 0;
        const bt = b.lastSession ? new Date(b.lastSession.finished_at).getTime() : 0;
        return bt - at;
    });

    // 반 전체 약점 빈도 (학생 단위 — 한 학생이 같은 약점 여러 번 진단해도 1로 셈)
    const studentsWithWeakness = {};
    for (const [uid, sList] of sessionsByUser.entries()) {
        if (!profileById[uid] || profileById[uid].role !== 'student') continue;
        const studentWeak = new Set(sList.flatMap(s => s.weak_concepts || []));
        for (const w of studentWeak) studentsWithWeakness[w] = (studentsWithWeakness[w] || 0) + 1;
    }
    const classWeak = Object.entries(studentsWithWeakness)
        .map(([cid, count]) => ({ cid, count }))
        .sort((a, b) => b.count - a.count);

    state.teacherData = {
        students: studentList,
        sessions,
        sessionsByUser,
        classWeak,
        totalSessions: sessions.length,
        masteryByUser,
    };
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
// 적응형 진단 — 개념 숙련도 (mastery)
// ─────────────────────────────────────────────────────────

function getMasteryStatus(m) {
    if (!m || !m.total_seen) return 'unknown';
    if (m.correct_streak >= MASTERY_THRESHOLD) return 'mastered';
    if (m.correct_streak >= 1) return 'developing';
    return 'weak';
}

function getMasteryLevel(m) {
    const s = getMasteryStatus(m);
    if (s === 'mastered') return 3;
    if (s === 'weak') return 1;
    return 2; // unknown / developing
}

function shouldTestInBattery(conceptId) {
    const m = state.mastery?.[conceptId];
    if (!m) return true;
    if (getMasteryStatus(m) !== 'mastered') return true;
    if (!m.last_seen_at) return true;
    const daysSince = (Date.now() - new Date(m.last_seen_at).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince > MASTERY_RECHECK_DAYS) return true;
    return Math.random() < MASTERY_RANDOM_RECHECK;
}

async function updateMastery(conceptId, correct) {
    if (!state.user || !conceptId) return;
    state.mastery = state.mastery || {};

    const existing = state.mastery[conceptId] || {
        user_id: state.user.id,
        concept_id: conceptId,
        correct_streak: 0,
        total_seen: 0,
        total_correct: 0,
        last_seen_at: null,
        last_correct_at: null,
        last_wrong_at: null,
    };

    const now = new Date().toISOString();
    const prevStreak = existing.correct_streak || 0;
    const newStreak = correct
        ? prevStreak + 1
        : Math.max(0, prevStreak - STREAK_DECAY_ON_WRONG);
    const updated = {
        ...existing,
        total_seen: (existing.total_seen || 0) + 1,
        total_correct: (existing.total_correct || 0) + (correct ? 1 : 0),
        correct_streak: newStreak,
        last_seen_at: now,
        last_correct_at: correct ? now : existing.last_correct_at,
        last_wrong_at: correct ? existing.last_wrong_at : now,
    };
    state.mastery[conceptId] = updated;

    try {
        await sb.from('concept_mastery').upsert({
            user_id: updated.user_id,
            concept_id: updated.concept_id,
            correct_streak: updated.correct_streak,
            total_seen: updated.total_seen,
            total_correct: updated.total_correct,
            last_seen_at: updated.last_seen_at,
            last_correct_at: updated.last_correct_at,
            last_wrong_at: updated.last_wrong_at,
        });
    } catch (e) { console.warn('mastery save failed', e); }
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
        { text: problem['정답'], weakness: '', explanation: '', isCorrect: true },
        { text: problem['오답1'], weakness: problem['약점1'], explanation: problem['오답해설1'] || '', isCorrect: false },
        { text: problem['오답2'], weakness: problem['약점2'], explanation: problem['오답해설2'] || '', isCorrect: false },
        { text: problem['오답3'], weakness: problem['약점3'], explanation: problem['오답해설3'] || '', isCorrect: false },
        { text: problem['오답4'], weakness: problem['약점4'], explanation: problem['오답해설4'] || '', isCorrect: false },
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
        const target = opts.targetLevel || 2;
        // 1순위: 정확히 같은 난이도 중 랜덤
        const exact = pool.filter(p => parseInt(p['난이도']) === target);
        if (exact.length > 0) return exact[Math.floor(Math.random() * exact.length)];
        // 2순위: ±1 이내
        const close = pool.filter(p => Math.abs(parseInt(p['난이도']) - target) <= 1);
        const candidates = close.length > 0 ? close : pool;
        return candidates[Math.floor(Math.random() * candidates.length)];
    }
    pool.sort((a, b) => parseInt(a['난이도']) - parseInt(b['난이도']));
    return pool[0];
}

// ─────────────────────────────────────────────────────────
// 진단 흐름
// ─────────────────────────────────────────────────────────

function buildDynamicBattery() {
    // 1단계: 코어 배터리에서 마스터 안 된 개념만
    let battery = DIAGNOSTIC_BATTERY.filter(shouldTestInBattery);

    // 2단계: 부족하면 가장 적게 본 비마스터 개념으로 보충
    if (battery.length < TARGET_BATTERY_SIZE) {
        const allCids = state.concepts.map(c => c['개념ID']);
        const supplements = allCids
            .filter(cid => !battery.includes(cid))
            .filter(cid => shouldTestInBattery(cid))
            .map(cid => ({ cid, seen: state.mastery?.[cid]?.total_seen || 0 }))
            .sort((a, b) => a.seen - b.seen);  // 적게 본 순
        const needed = TARGET_BATTERY_SIZE - battery.length;
        for (const s of supplements.slice(0, needed)) battery.push(s.cid);
    }

    // 너무 많으면 자르기
    if (battery.length > TARGET_BATTERY_SIZE) {
        battery = shuffle(battery).slice(0, TARGET_BATTERY_SIZE);
    }

    // 모두 마스터 (배터리 비어있을 수도) → 무작위 마스터 4개 검증
    if (battery.length === 0) {
        battery = shuffle([...DIAGNOSTIC_BATTERY]).slice(0, 4);
    }

    return shuffle(battery);
}

function startDiagnosis() {
    state.mode = 'dx';
    const battery = buildDynamicBattery();
    state.dx = {
        queue: battery,
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
        const targetLevel = getMasteryLevel(state.mastery?.[conceptId]);
        const problem = pickProblem(conceptId, { diagnostic: true, targetLevel });
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
            if (state.dx.queue.includes(pre) || alreadyTested) continue;
            // 마스터된 선수 개념은 드릴다운에서 건너뜀 (오개념 의심 안 함)
            const m = state.mastery?.[pre];
            if (m && getMasteryStatus(m) === 'mastered') continue;
            state.dx.queue.push(pre);
        }
    }

    state.dx.history.push({
        problemId: problem['문제ID'],
        conceptId: problem['점검개념ID'],
        question: problem['문제'],
        chosenText: chosen.text,
        chosenExplanation: chosen.explanation || '',
        correctAnswer: problem['정답'],
        correct,
        inferred,
    });

    updateMastery(problem['점검개념ID'], correct);

    saveDxToCloud();
    render();

    // 정답이면 1초 후 자동으로 다음 문제
    if (correct) {
        const snapshotProblemId = problem['문제ID'];
        setTimeout(() => {
            if (state.mode === 'dx' && state.dx?.showingFeedback
                && state.dx.currentProblem?.['문제ID'] === snapshotProblemId) {
                nextDxQuestion();
            }
        }, 1000);
    }
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
        if (state.dx.queue.includes(pre) || alreadyTested) continue;
        const m = state.mastery?.[pre];
        if (m && getMasteryStatus(m) === 'mastered') continue;
        state.dx.queue.push(pre);
    }
    state.dx.history.push({
        problemId: problem['문제ID'],
        conceptId: problem['점검개념ID'],
        question: problem['문제'],
        chosenText: '(모름)',
        chosenExplanation: '',
        correctAnswer: problem['정답'],
        correct: false,
        inferred,
    });
    updateMastery(problem['점검개념ID'], false);
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
        // 현재 mastery 상태가 mastered/developing 이면 추천 대상에서 제외
        // (한두 번 실수했어도 평소 잘하는 개념이라면 재학습 권유 X)
        const m = state.mastery?.[cid];
        const status = getMasteryStatus(m);
        if (status === 'mastered' || status === 'developing') continue;
        const prereqs = getPrereqs(cid);
        const anyWeakPrereq = prereqs.some(p => weak.has(p));
        if (!anyWeakPrereq) roots.push(cid);
    }
    return roots;
}

// 누적 mastery 기반 현재 약점 분석 (이번 세션 무관)
function findCurrentRootWeakness() {
    const mastery = state.mastery || {};
    const weakConcepts = Object.keys(mastery).filter(cid =>
        getMasteryStatus(mastery[cid]) === 'weak'
    );
    if (weakConcepts.length === 0) return null;
    const weakSet = new Set(weakConcepts);
    // 약점 중 선수 개념도 약점인 게 없으면 뿌리
    const roots = weakConcepts.filter(cid => {
        const prereqs = getPrereqs(cid);
        return !prereqs.some(p => weakSet.has(p));
    });
    const candidates = roots.length > 0 ? roots : weakConcepts;
    // 정답률 낮은 순
    candidates.sort((a, b) => {
        const ma = mastery[a], mb = mastery[b];
        const accA = ma.total_seen > 0 ? ma.total_correct / ma.total_seen : 0;
        const accB = mb.total_seen > 0 ? mb.total_correct / mb.total_seen : 0;
        return accA - accB;
    });
    return candidates[0] || null;
}

// ─────────────────────────────────────────────────────────
// 개념 설명 페이지 → 학습(연습) 흐름
// ─────────────────────────────────────────────────────────

function studyConcept(conceptId) {
    state.studyConceptId = conceptId;
    state.mode = 'conceptStudy';
    render();
}

function startPracticeFromStudy() {
    if (state.studyConceptId) {
        startPractice(state.studyConceptId);
    }
}

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
    updateMastery(state.practice.currentProblem?.['점검개념ID'], chosen.isCorrect);
    savePracticeToCloud();
    render();

    // 정답이면 1초 후 자동으로 다음 문제
    if (chosen.isCorrect) {
        const snapshotProblemId = state.practice.currentProblem?.['문제ID'];
        setTimeout(() => {
            if (state.mode === 'practice' && state.practice?.showingFeedback
                && state.practice.currentProblem?.['문제ID'] === snapshotProblemId) {
                nextPracticeQuestion();
            }
        }, 1000);
    }
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
    else if (state.profile?.role === 'teacher') {
        if (state.mode === 'teacherStudent') root.innerHTML = renderTeacherStudent();
        else if (state.mode === 'pastResult') root.innerHTML = renderPastResult();
        else if (state.mode === 'teacherProblems') root.innerHTML = renderTeacherProblems();
        else if (state.mode === 'teacherConceptProblems') root.innerHTML = renderTeacherConceptProblems();
        else root.innerHTML = renderTeacherDashboard();
    }
    else if (state.mode === 'admin') root.innerHTML = renderAdminPrompt();
    else if (state.mode === 'welcome') root.innerHTML = renderWelcome();
    else if (state.mode === 'dx') root.innerHTML = renderDx();
    else if (state.mode === 'result') root.innerHTML = renderResult();
    else if (state.mode === 'conceptStudy') root.innerHTML = renderConceptStudy();
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
    const adminInput = document.getElementById('admin-password-input');
    if (adminInput) {
        adminInput.focus();
        adminInput.addEventListener('keypress', e => {
            if (e.key === 'Enter') submitAdminPassword();
        });
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

    // Mastery 누적 요약 + 영역별
    const mastery = state.mastery || {};
    const concepts = state.concepts || [];
    let mastered = 0, developing = 0, weak = 0;
    for (const cid of Object.keys(mastery)) {
        const status = getMasteryStatus(mastery[cid]);
        if (status === 'mastered') mastered++;
        else if (status === 'developing') developing++;
        else if (status === 'weak') weak++;
    }
    const totalTracked = mastered + developing + weak;
    const untouched = Math.max(0, concepts.length - totalTracked);

    // 영역별 진척도
    const byArea = {};
    for (const c of concepts) {
        const area = c['영역'] || '기타';
        if (!byArea[area]) byArea[area] = { total: 0, mastered: 0, dev: 0, weak: 0 };
        byArea[area].total++;
        const m = mastery[c['개념ID']];
        if (m) {
            const s = getMasteryStatus(m);
            if (s === 'mastered') byArea[area].mastered++;
            else if (s === 'developing') byArea[area].dev++;
            else if (s === 'weak') byArea[area].weak++;
        }
    }

    // 현재 약점 TOP (정답률 낮은 순)
    const weaknessList = [];
    for (const cid of Object.keys(mastery)) {
        const m = mastery[cid];
        if (getMasteryStatus(m) !== 'weak') continue;
        const acc = m.total_seen > 0 ? m.total_correct / m.total_seen : 0;
        weaknessList.push({ cid, m, acc });
    }
    weaknessList.sort((a, b) => a.acc - b.acc);
    const topWeak = weaknessList.slice(0, 5);

    // 추천 학습 (현재 약점 중 뿌리)
    const recCid = findCurrentRootWeakness();
    const recName = recCid ? (state.conceptsById[recCid]?.['개념명'] || recCid) : null;

    return `
        <div class="card">
            <div class="header-row">
                <h1>📘 ${escapeHTML(getDisplayName())}님</h1>
                <button class="link-btn" onclick="doLogout()">로그아웃</button>
            </div>

            ${totalTracked > 0 ? `
                <div class="mastery-summary four-cols">
                    <div class="m-stat m-mastered"><b>${mastered}</b><span>🌟 마스터</span></div>
                    <div class="m-stat m-developing"><b>${developing}</b><span>📈 학습 중</span></div>
                    <div class="m-stat m-weak"><b>${weak}</b><span>⚠️ 약점</span></div>
                    <div class="m-stat m-untouched"><b>${untouched}</b><span>📋 미시도</span></div>
                </div>

                <h3>영역별 진척도</h3>
                <div class="area-progress">
                    ${Object.entries(byArea).map(([area, stats]) => {
                        const pct = stats.total > 0 ? Math.round(stats.mastered / stats.total * 100) : 0;
                        return `<div class="area-row">
                            <span class="area-name">${escapeHTML(area)}</span>
                            <div class="area-bar"><div class="area-fill" style="width:${pct}%"></div></div>
                            <span class="area-frac">${stats.mastered}/${stats.total}</span>
                        </div>`;
                    }).join('')}
                </div>

                ${topWeak.length > 0 ? `
                    <h3>⚠️ 현재 약점 TOP ${topWeak.length}</h3>
                    <ul class="weakness-list">
                        ${topWeak.map(({cid, m, acc}) => {
                            const c = state.conceptsById[cid];
                            return `<li>
                                <b>${escapeHTML(c?.['개념명'] || cid)}</b>
                                <span class="meta"> · 정답률 ${Math.round(acc * 100)}% (${m.total_correct}/${m.total_seen})</span>
                            </li>`;
                        }).join('')}
                    </ul>
                ` : ''}
            ` : `
                <p class="meta">아직 진단 데이터가 없어요. 진단을 시작해보세요.</p>
            `}

            ${recCid ? `
                <button class="primary block" onclick="studyConcept('${recCid}')">🌱 추천 학습: ${escapeHTML(recName)}</button>
            ` : ''}

            ${inProgressKind ? `
                <div class="resume-banner">진행 중인 ${inProgressKind}이 있어요.</div>
                <button class="primary block" onclick="resumeProgress()">▶ 이어풀기</button>
                <button class="block" onclick="startDiagnosis()">새 진단 시작</button>
            ` : `
                <button class="${recCid ? '' : 'primary'} block" onclick="startDiagnosis()">새 진단 시작하기</button>
            `}
            ${sessionCount > 0 ? `<button class="block" onclick="viewHistory()">📋 지난 기록 보기 (${sessionCount}회)</button>` : ''}
            <p class="admin-link-row">
                <a class="admin-link" onclick="showAdminPrompt()">관리자로 전환</a>
            </p>
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
        const chosen = dx.selectedIndex !== null ? dx.currentChoices[dx.selectedIndex] : null;
        const isCorrect = chosen?.isCorrect;

        if (isCorrect) {
            return `
                <div class="card">
                    <div class="progress-bar"><div class="progress-fill" style="width:${progress}%"></div></div>
                    <div class="meta">진단 ${askedCount}번째 문제 · ${escapeHTML(concept['개념명'])} 점검</div>
                    <div class="problem">${formatMath(p['문제'])}</div>
                    ${renderChoices(dx.currentChoices, dx.selectedIndex, true, 'selectDxChoice')}
                    <div class="correct correct-flash">✓ 정답입니다!</div>
                    <div class="auto-advance">잠시 후 다음 문제로 넘어갑니다...</div>
                </div>
            `;
        }
        return `
            <div class="card">
                <div class="progress-bar"><div class="progress-fill" style="width:${progress}%"></div></div>
                <div class="meta">진단 ${askedCount}번째 문제 · ${escapeHTML(concept['개념명'])} 점검</div>
                <div class="problem">${formatMath(p['문제'])}</div>
                ${renderChoices(dx.currentChoices, dx.selectedIndex, true, 'selectDxChoice')}
                <div class="wrong">✗ 정답은 <b>${formatMath(p['정답'])}</b></div>
                ${chosen?.explanation
                    ? `<div class="why-wrong">⚠️ 이 답이 틀린 이유: ${formatMath(chosen.explanation)}</div>`
                    : ''}
                <div class="solution">💡 ${formatMath(p['해설'])}</div>
                ${inferredConcept
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
                <p>아래 개념부터 학습하시면 위쪽 약점들이 함께 풀려요. 개념 설명을 먼저 보고 문제를 풀 수 있어요.</p>
                ${roots.map(cid => {
                    const c = state.conceptsById[cid];
                    if (!c) return '';
                    return `<button class="primary block" onclick="studyConcept('${cid}')">📖 ${escapeHTML(c['개념명'])} 개념 보기</button>`;
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
                    → 선택: <b>${formatMath(h.chosenText)}</b>
                    ${!h.correct ? `· 정답: <b>${formatMath(h.correctAnswer)}</b>` : ''}
                    ${!h.correct && h.chosenExplanation
                        ? `<div class="why-wrong-mini">⚠️ ${formatMath(h.chosenExplanation)}</div>`
                        : ''}
                    <span class="meta">점검: ${escapeHTML(cName)}${h.inferred && h.inferred !== h.conceptId ? ` · 짚이는 약점: ${escapeHTML(state.conceptsById[h.inferred]?.['개념명'] || h.inferred)}` : ''}</span>
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
        const chosen = pr.selectedIndex !== null ? pr.currentChoices[pr.selectedIndex] : null;
        if (isCorrect) {
            return `
                <div class="card">
                    <div class="meta">학습 중: ${escapeHTML(concept['개념명'])} · 난이도 ${escapeHTML(p['난이도'])}</div>
                    <div class="problem">${formatMath(p['문제'])}</div>
                    ${renderChoices(pr.currentChoices, pr.selectedIndex, true, 'selectPracticeChoice')}
                    <div class="correct correct-flash">✓ 정답입니다!</div>
                    <div class="auto-advance">잠시 후 다음 문제로 넘어갑니다...</div>
                </div>
            `;
        }
        return `
            <div class="card">
                <div class="meta">학습 중: ${escapeHTML(concept['개념명'])} · 난이도 ${escapeHTML(p['난이도'])}</div>
                <div class="problem">${formatMath(p['문제'])}</div>
                ${renderChoices(pr.currentChoices, pr.selectedIndex, true, 'selectPracticeChoice')}
                <div class="wrong">✗ 정답은 <b>${formatMath(p['정답'])}</b></div>
                ${chosen?.explanation
                    ? `<div class="why-wrong">⚠️ 이 답이 틀린 이유: ${formatMath(chosen.explanation)}</div>`
                    : ''}
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

function backFromPastResult() {
    if (state.profile?.role === 'teacher' && state.viewStudentId) {
        state.mode = 'teacherStudent';
        state.viewSession = null;
    } else {
        state.mode = 'history';
        state.viewSession = null;
    }
    render();
}

function renderPastResult() {
    const sess = state.viewSession;
    if (!sess) return '<div class="card"><p>세션을 찾을 수 없어요.</p><button onclick="backFromPastResult()">목록으로</button></div>';
    const isTeacher = state.profile?.role === 'teacher';
    const weak = sess.weak_concepts || [];
    const roots = sess.root_concepts || [];
    let studentLabel = '';
    if (isTeacher && state.viewStudentId && state.teacherData) {
        const stu = state.teacherData.students.find(s => s.id === state.viewStudentId);
        if (stu) studentLabel = `<p class="meta">${escapeHTML(stu.username)} 학생</p>`;
    }
    return `
        <div class="card">
            <h2>📊 ${formatDate(sess.finished_at)} 진단</h2>
            ${studentLabel}
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
                ${isTeacher
                    ? `<button class="block" onclick="backFromPastResult()">← 학생 상세로</button>
                       <button class="block" onclick="backToTeacherDashboard()">대시보드로</button>`
                    : `<button class="block" onclick="backFromPastResult()">기록 목록으로</button>
                       <button class="block" onclick="restart()">처음으로</button>`}
            </p>
        </div>
    `;
}

// ─────────────────────────────────────────────────────────
// 선생님 대시보드
// ─────────────────────────────────────────────────────────

function viewStudent(userId) {
    state.viewStudentId = userId;
    state.mode = 'teacherStudent';
    render();
}

function backToTeacherDashboard() {
    state.mode = 'welcome';
    state.viewStudentId = null;
    state.viewSession = null;
    render();
}

function viewStudentSession(sessionId) {
    const td = state.teacherData;
    if (!td) return;
    const sess = td.sessions.find(s => s.id === sessionId);
    if (!sess) return;
    state.viewSession = sess;
    state.mode = 'pastResult';
    render();
}

async function refreshTeacherData() {
    await loadTeacherData();
    render();
}

function renderTeacherDashboard() {
    const td = state.teacherData;
    if (!td) {
        return `<div class="card"><p>대시보드 불러오는 중...</p></div>`;
    }
    const studentCount = td.students.length;
    const totalSessions = td.totalSessions;
    const top = td.classWeak.slice(0, 10);

    return `
        <div class="card">
            <div class="header-row">
                <h1>👨‍🏫 ${escapeHTML(getDisplayName())} 선생님</h1>
                <button class="link-btn" onclick="doLogout()">로그아웃</button>
            </div>

            <div class="stats-row">
                <div class="stat"><b>${studentCount}</b><span class="meta">학생</span></div>
                <div class="stat"><b>${totalSessions}</b><span class="meta">진단 누적</span></div>
                <div class="stat"><b>${td.classWeak.length}</b><span class="meta">발견된 개념 약점</span></div>
            </div>

            <button class="link-btn" onclick="refreshTeacherData()" style="float:right;margin-top:-8px">↻ 새로고침</button>

            <button class="block" onclick="viewProblemBank()" style="margin-top:8px">📚 문제 은행 둘러보기</button>

            <h3>🔥 우리반 자주 막히는 개념 (학생 수 기준)</h3>
            ${top.length === 0
                ? '<p class="meta">아직 진단 데이터가 없어요.</p>'
                : `<ul class="weakness-list">
                    ${top.map((w, i) => {
                        const c = state.conceptsById[w.cid];
                        const name = c ? c['개념명'] : w.cid;
                        const pct = studentCount > 0 ? Math.round((w.count / studentCount) * 100) : 0;
                        return `<li>
                            <b>${i+1}. ${escapeHTML(name)}</b>
                            <span class="meta">— ${w.count}명 (${pct}%)</span>
                            <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
                        </li>`;
                    }).join('')}
                </ul>`}

            <h3>👥 학생 목록 (${studentCount}명)</h3>
            ${studentCount === 0 ? '<p class="meta">아직 가입한 학생이 없어요.</p>' : `
                <ul class="weakness-list">
                    ${td.students.map(s => `
                        <li class="student-row" onclick="viewStudent('${s.id}')">
                            <b>${escapeHTML(s.username)}</b>
                            <span class="meta">
                                · 진단 ${s.sessionCount}회
                                · 약점 ${s.uniqueWeakCount}개
                                ${s.lastSession ? `· 마지막 ${formatDate(s.lastSession.finished_at)}` : '· 아직 안 풀어봄'}
                            </span>
                        </li>
                    `).join('')}
                </ul>
            `}
        </div>
    `;
}

function renderTeacherStudent() {
    const td = state.teacherData;
    const sid = state.viewStudentId;
    if (!td || !sid) return '<div class="card"><p>학생을 찾을 수 없어요.</p><button onclick="backToTeacherDashboard()">대시보드로</button></div>';

    const student = td.students.find(s => s.id === sid);
    if (!student) return '<div class="card"><p>학생 정보 없음.</p><button onclick="backToTeacherDashboard()">대시보드로</button></div>';

    const studentSessions = td.sessionsByUser.get(sid) || [];
    // 누적 약점 빈도
    const weakFreq = {};
    for (const s of studentSessions) {
        for (const w of (s.weak_concepts || [])) {
            weakFreq[w] = (weakFreq[w] || 0) + 1;
        }
    }
    const weakSorted = Object.entries(weakFreq).sort((a, b) => b[1] - a[1]);

    // 학생 mastery 정보
    const sm = td.masteryByUser?.[sid] || {};
    const masteryByStatus = { mastered: [], developing: [], weak: [], unknown: [] };
    for (const cid of Object.keys(sm)) {
        const status = getMasteryStatus(sm[cid]);
        masteryByStatus[status].push({ cid, m: sm[cid] });
    }

    return `
        <div class="card">
            <div class="header-row">
                <h2>👤 ${escapeHTML(student.username)} 학생</h2>
                <button class="link-btn" onclick="backToTeacherDashboard()">← 대시보드</button>
            </div>
            <p class="meta">
                진단 ${student.sessionCount}회 ·
                평균 점수 ${studentSessions.length > 0
                    ? Math.round(studentSessions.reduce((sum, s) => sum + s.score, 0) / studentSessions.reduce((sum, s) => sum + s.total, 0) * 100) + '%'
                    : '—'}
            </p>

            ${(masteryByStatus.mastered.length + masteryByStatus.developing.length + masteryByStatus.weak.length) > 0 ? `
                <div class="mastery-summary">
                    <div class="m-stat m-mastered"><b>${masteryByStatus.mastered.length}</b><span>🌟 마스터</span></div>
                    <div class="m-stat m-developing"><b>${masteryByStatus.developing.length}</b><span>📈 학습 중</span></div>
                    <div class="m-stat m-weak"><b>${masteryByStatus.weak.length}</b><span>⚠️ 약점</span></div>
                </div>
                <h3>개념별 숙련도</h3>
                ${['mastered','developing','weak'].map(status => {
                    const list = masteryByStatus[status];
                    if (!list.length) return '';
                    const label = { mastered: '🌟 마스터', developing: '📈 학습 중', weak: '⚠️ 약점' }[status];
                    return `<details ${status === 'weak' ? 'open' : ''}>
                        <summary><b>${label} (${list.length})</b></summary>
                        <ul class="weakness-list">
                            ${list.map(({cid, m}) => {
                                const c = state.conceptsById[cid];
                                const name = c ? c['개념명'] : cid;
                                return `<li>
                                    <b>${escapeHTML(name)}</b>
                                    <span class="meta">${cid} · ${m.total_correct}/${m.total_seen} 정답 · 연속 ${m.correct_streak}회</span>
                                </li>`;
                            }).join('')}
                        </ul>
                    </details>`;
                }).join('')}
            ` : ''}

            ${weakSorted.length === 0 ? '<p>아직 진단 데이터가 없어요.</p>' : `
                <h3>누적 약점 (자주 틀린 순)</h3>
                <ul class="weakness-list">
                    ${weakSorted.map(([cid, count]) => {
                        const c = state.conceptsById[cid];
                        const name = c ? c['개념명'] : cid;
                        return `<li>
                            <b>${escapeHTML(name)}</b>
                            <span class="meta">${cid} · ${count}회 진단에서 약함</span>
                        </li>`;
                    }).join('')}
                </ul>

                <h3>진단 이력</h3>
                <ul class="weakness-list">
                    ${studentSessions.map(s => `
                        <li class="student-row" onclick="viewStudentSession(${s.id})">
                            <b>${formatDate(s.finished_at)}</b>
                            <span class="meta"> · 점수 ${s.score}/${s.total} · 약점 ${(s.weak_concepts || []).length}개</span>
                        </li>
                    `).join('')}
                </ul>

                ${(() => {
                    const allItems = studentSessions.flatMap(s =>
                        (s.history || []).map(h => ({ ...h, sessionDate: s.finished_at }))
                    );
                    const allWrong = allItems.filter(h => !h.correct);
                    const allCorrect = allItems.filter(h => h.correct);

                    const renderItem = (h, isWrong) => {
                        const c = state.conceptsById[h.conceptId];
                        const cName = c ? c['개념명'] : h.conceptId;
                        return `<div class="history-item ${isWrong ? 'wrong' : 'correct'}">
                            <span class="meta">${formatDate(h.sessionDate)} · ${escapeHTML(cName)}</span><br>
                            [${h.problemId}] ${formatMath(h.question)}
                            <br>→ 선택: <b>${formatMath(h.chosenText)}</b>
                            ${isWrong ? `· 정답: <b>${formatMath(h.correctAnswer)}</b>` : ''}
                            ${isWrong && h.chosenExplanation
                                ? `<div class="why-wrong-mini">⚠️ ${formatMath(h.chosenExplanation)}</div>`
                                : ''}
                        </div>`;
                    };

                    let result = '';
                    if (allWrong.length > 0) {
                        result += `
                            <h3>📝 전체 오답 (${allWrong.length}개)</h3>
                            <div class="history">${allWrong.map(h => renderItem(h, true)).join('')}</div>
                        `;
                    }
                    if (allCorrect.length > 0) {
                        result += `
                            <h3>✓ 전체 정답 (${allCorrect.length}개)</h3>
                            <div class="history">${allCorrect.map(h => renderItem(h, false)).join('')}</div>
                        `;
                    }
                    return result;
                })()}
            `}
        </div>
    `;
}

// ─────────────────────────────────────────────────────────
// 개념 설명 페이지 (학생용)
// ─────────────────────────────────────────────────────────

function renderConceptStudy() {
    const cid = state.studyConceptId;
    const c = state.conceptsById[cid];
    if (!c) return '<div class="card"><p>개념을 찾을 수 없어요.</p><button onclick="restart()">처음으로</button></div>';

    const example = c['예시'] || '';
    const description = c['개념설명'] || c['한줄설명'] || '';

    return `
        <div class="card">
            <div class="header-row">
                <h2>📖 ${escapeHTML(c['개념명'])}</h2>
                <button class="link-btn" onclick="state.mode='result'; render();">← 결과</button>
            </div>
            <p class="meta">${escapeHTML(c['영역'])} · ${escapeHTML(c['학년단계'])} · ${cid}</p>

            <h3>한줄 요약</h3>
            <p>${formatMath(c['한줄설명'] || '')}</p>

            <h3>설명</h3>
            <p style="line-height:1.7">${formatMath(description)}</p>

            ${example ? `
                <h3>예시</h3>
                <div class="example-box">${formatMath(example)}</div>
            ` : ''}

            <button class="primary block" style="margin-top:24px" onclick="startPracticeFromStudy()">▶ 개념 확인 문제 풀기</button>
            <button class="block" onclick="state.mode='result'; render();">결과로 돌아가기</button>
        </div>
    `;
}

// ─────────────────────────────────────────────────────────
// 선생님 - 문제 은행 둘러보기
// ─────────────────────────────────────────────────────────

function viewProblemBank() {
    state.mode = 'teacherProblems';
    state.viewConceptId = null;
    render();
}

function viewConceptProblems(conceptId) {
    state.viewConceptId = conceptId;
    state.mode = 'teacherConceptProblems';
    render();
}

function renderTeacherProblems() {
    const concepts = state.concepts;
    // 영역별로 그룹화
    const byArea = {};
    for (const c of concepts) {
        const area = c['영역'] || '기타';
        if (!byArea[area]) byArea[area] = [];
        byArea[area].push(c);
    }

    return `
        <div class="card">
            <div class="header-row">
                <h2>📚 문제 은행</h2>
                <button class="link-btn" onclick="backToTeacherDashboard()">← 대시보드</button>
            </div>
            <p class="meta">개념을 클릭하면 그 개념의 모든 문제(매력 오답 포함)를 볼 수 있어요</p>

            ${Object.entries(byArea).map(([area, list]) => `
                <h3>${escapeHTML(area)} (${list.length})</h3>
                <ul class="weakness-list">
                    ${list.map(c => {
                        const count = (state.problemsByConceptId[c['개념ID']] || []).length;
                        return `<li class="student-row" onclick="viewConceptProblems('${c['개념ID']}')">
                            <b>${c['개념ID']} ${escapeHTML(c['개념명'])}</b>
                            <span class="meta">· 문제 ${count}개 · ${escapeHTML(c['학년단계'])}</span>
                        </li>`;
                    }).join('')}
                </ul>
            `).join('')}
        </div>
    `;
}

function renderTeacherConceptProblems() {
    const cid = state.viewConceptId;
    const c = state.conceptsById[cid];
    if (!c) return '<div class="card"><p>개념 정보 없음.</p><button onclick="viewProblemBank()">목록으로</button></div>';
    const problems = state.problemsByConceptId[cid] || [];

    return `
        <div class="card">
            <div class="header-row">
                <h2>📚 ${escapeHTML(c['개념명'])}</h2>
                <button class="link-btn" onclick="viewProblemBank()">← 문제 은행</button>
            </div>
            <p class="meta">${cid} · ${escapeHTML(c['영역'])} · ${escapeHTML(c['학년단계'])} · 문제 ${problems.length}개</p>
            <div class="solution" style="margin-bottom:20px">
                <b>개념 설명:</b> ${formatMath(c['개념설명'] || c['한줄설명'] || '')}
                ${c['예시'] ? `<br><br><b>예시:</b> ${formatMath(c['예시'])}` : ''}
            </div>

            ${problems.map((p, idx) => `
                <div class="problem-card">
                    <div class="meta">[${p['문제ID']}] 난이도 ${p['난이도']} · ${escapeHTML(p['용도'])} · ${escapeHTML(p['유형'] || '')}</div>
                    <div class="problem">${formatMath(p['문제'])}</div>
                    <div class="correct" style="margin:8px 0">정답: <b>${formatMath(p['정답'])}</b></div>
                    <div class="solution">💡 ${formatMath(p['해설'])}</div>

                    <h4 style="margin:14px 0 6px;font-size:14px;color:#666">매력 오답</h4>
                    ${[1,2,3,4].map(i => {
                        const wrongText = p[`오답${i}`];
                        const weak = p[`약점${i}`];
                        const explain = p[`오답해설${i}`];
                        if (!wrongText) return '';
                        const weakName = weak ? (state.conceptsById[weak]?.['개념명'] || weak) : '';
                        return `<div class="distractor">
                            <b>${formatMath(wrongText)}</b>
                            ${weakName ? `<span class="meta"> → ${escapeHTML(weakName)} (${weak})</span>` : ''}
                            ${explain ? `<div class="why-wrong-mini">${formatMath(explain)}</div>` : ''}
                        </div>`;
                    }).join('')}
                </div>
            `).join('')}
        </div>
    `;
}

window.addEventListener('DOMContentLoaded', init);
