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
    expandedClassConcept: null, // { kind: 'weak'|'suspected', cid } — 대시보드에서 펼쳐진 개념
    studyConceptId: null,    // 학생 - 개념 설명 페이지에서 보고 있는 개념
    viewConceptId: null,     // 선생님 - 개념별 문제 보기에서 선택한 개념
    mastery: null,           // { [conceptId]: { correct_streak, total_seen, total_correct, ... } }
    masteryListFilter: null, // 'mastered' | 'developing' | 'weak' | 'untouched' | null
    recomputeBusy: false,    // 재계산 중 여부
};

// 적응형 진단 파라미터
const MASTERY_THRESHOLD = 4;          // 연속 정답 N회 = 마스터
const MASTERY_RECHECK_DAYS = 30;      // 마스터 후 N일 지나면 재검증
const MASTERY_RANDOM_RECHECK = 0.05;  // 마스터여도 무작위 재검증 확률
const STREAK_DECAY_ON_WRONG = 2;      // 오답 시 streak 감쇠량 (전체 리셋 X — 1번 실수로 약점 처리 X)
const TARGET_BATTERY_SIZE = 8;        // 동적 배터리 목표 크기
const PRACTICE_TARGET_CORRECT = 5;    // 학습 모드 종료 기준 정답 수

const DIAGNOSTIC_BATTERY = [
    'F04', 'F05', 'I05', 'M06', 'P01', 'P07', 'E03',  // 수와 식
    'B02', 'H03', 'G02', 'V01'                          // 부등식 / 함수 / 좌표 / 유리식
];
const MAX_DX_QUESTIONS = 18;

// 학년 빠른 추정용 anchors — 학년별 한 개씩 (이분 탐색)
// log2(6) ≈ 3 문제 안에 학년 구간이 좁혀짐
const GRADE_ANCHORS = [
    { grade: 5,  conceptId: 'F04' },  // 초5  분수의 덧셈·뺄셈
    { grade: 6,  conceptId: 'F06' },  // 초6  소수↔분수 변환
    { grade: 7,  conceptId: 'I05' },  // 중1  유리수의 사칙연산
    { grade: 8,  conceptId: 'F07' },  // 중2  순환소수
    { grade: 9,  conceptId: 'P07' },  // 중3  이차식 인수분해
    { grade: 10, conceptId: 'V01' },  // 고1  유리식의 약분
];
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
    // RFC 4180 풍 — 큰따옴표로 감싼 필드 안의 콤마/줄바꿈 처리
    const rows = [];
    let field = '', row = [], inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i+1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else {
                field += ch;
            }
        } else {
            if (ch === '"') inQuotes = true;
            else if (ch === ',') { row.push(field); field = ''; }
            else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
            else if (ch === '\r') { /* skip */ }
            else field += ch;
        }
    }
    if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
    if (rows.length === 0) return [];
    const headers = rows[0].map(h => h.trim());
    return rows.slice(1)
        .filter(r => r.length > 1 || (r[0] && r[0].trim() !== ''))
        .map(fields => {
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
        const [ip, allSessions, masteryRes] = await Promise.all([
            sb.from('in_progress').select('current_dx, current_practice').eq('user_id', state.user.id).maybeSingle(),
            sb.from('sessions').select('id, kind, finished_at, score, total, weak_concepts, root_concepts, history, concept_id').eq('user_id', state.user.id).order('finished_at', { ascending: false }),
            sb.from('concept_mastery').select('*').eq('user_id', state.user.id),
        ]);
        state.inProgress = ip.data || { current_dx: null, current_practice: null };
        const sessList = allSessions.data || [];
        state.sessions = sessList;
        state.sessionCount = sessList.filter(s => s.kind !== 'practice').length;
        state.practiceCount = sessList.filter(s => s.kind === 'practice').length;
        state.teacherData = null;

        // mastery: { conceptId: row } 맵
        const mm = {};
        for (const m of (masteryRes.data || [])) mm[m.concept_id] = m;
        state.mastery = mm;

        // 자동 복구: 진단 기록은 있는데 mastery가 비어있으면 sessions에서 재계산
        if (state.sessionCount > 0 && Object.keys(state.mastery).length === 0) {
            console.log('mastery 데이터가 비어있어 진단 기록에서 자동 복구합니다.');
            await recomputeAndSaveMastery();
        }
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
        const sm = masteryByUser[p.id] || {};
        // 현재 mastery 가 'weak' 인 개념 수 (직접 풀어 약점이 된 것만, 과거 추정 제외)
        const currentWeakCount = Object.keys(sm)
            .filter(cid => state.conceptsById[cid])
            .filter(cid => getMasteryStatus(sm[cid]) === 'weak')
            .length;
        return {
            ...p,
            sessionCount: userSessions.length,
            lastSession: userSessions[0] || null,
            uniqueWeakCount: currentWeakCount,
        };
    }).sort((a, b) => {
        // 최근 진단 본 학생 먼저
        const at = a.lastSession ? new Date(a.lastSession.finished_at).getTime() : 0;
        const bt = b.lastSession ? new Date(b.lastSession.finished_at).getTime() : 0;
        return bt - at;
    });

    // 반 전체 "현재 약점" — 학생별 mastery 'weak' 상태인 개념을 학생 수로 집계
    // (과거 누적 X, 직접 풀어 mastery 가 weak 가 된 경우만)
    const studentsWithWeakness = {};
    for (const p of allProfiles) {
        if (p.role !== 'student') continue;
        const mast = masteryByUser[p.id] || {};
        for (const cid of Object.keys(mast)) {
            if (!state.conceptsById[cid]) continue;
            if (getMasteryStatus(mast[cid]) !== 'weak') continue;
            studentsWithWeakness[cid] = (studentsWithWeakness[cid] || 0) + 1;
        }
    }
    const classWeak = Object.entries(studentsWithWeakness)
        .map(([cid, count]) => ({ cid, count }))
        .sort((a, b) => b.count - a.count);

    // 학생별 추정 약점 미리 계산 (개념 클릭 시 학생 목록 보여주기 위해)
    const suspectedByUser = {};
    for (const p of allProfiles) {
        if (p.role !== 'student') continue;
        const sList = sessionsByUser.get(p.id) || [];
        const sm = masteryByUser[p.id] || {};
        suspectedByUser[p.id] = computeSuspectedConcepts(sList, sm);
    }

    state.teacherData = {
        students: studentList,
        sessions,
        sessionsByUser,
        classWeak,
        totalSessions: sessions.length,
        masteryByUser,
        suspectedByUser,
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
    const newSession = {
        user_id: state.user.id,
        score: dx.history.filter(h => h.correct).length,
        total: dx.history.length,
        weak_concepts: [...dx.wrongConcepts],
        root_concepts: findRootWeaknesses(),
        history: dx.history,
    };
    const { error } = await sb.from('sessions').insert(newSession);
    if (error) console.error('세션 저장 실패', error);
    state.sessionCount += 1;
    // 메인 화면의 학년 추정·통계가 즉시 반영되도록 in-memory sessions 에도 push
    if (Array.isArray(state.sessions)) {
        state.sessions.unshift({ ...newSession, finished_at: new Date().toISOString() });
    }
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

// ─────────────────────────────────────────────────────────
// 학년 도달도 추정
// ─────────────────────────────────────────────────────────
function _gradeNum(label) {
    if (!label) return null;
    const m = label.match(/(초|중|고)(\d+)/);
    if (!m) return null;
    const base = m[1] === '초' ? 0 : m[1] === '중' ? 6 : 9;
    return base + parseInt(m[2]);
}

function _gradeLabel(num) {
    if (num <= 6) return `초${num}`;
    if (num <= 9) return `중${num - 6}`;
    return `고${num - 9}`;
}

function estimateGradeLevel(mastery) {
    const byGrade = new Map();
    for (const c of (state.concepts || [])) {
        const g = _gradeNum(c['학년단계']);
        if (g === null) continue;
        if (!byGrade.has(g)) byGrade.set(g, { total: 0, mastered: 0, developing: 0, weak: 0 });
        const stats = byGrade.get(g);
        stats.total++;
        const m = mastery?.[c['개념ID']];
        const status = getMasteryStatus(m);
        if (status === 'mastered') stats.mastered++;
        else if (status === 'developing') stats.developing++;
        else if (status === 'weak') stats.weak++;
    }
    const grades = [...byGrade.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([g, stats]) => ({
            grade: g,
            label: _gradeLabel(g),
            ...stats,
            ratio: stats.total > 0 ? stats.mastered / stats.total : 0,
        }));
    // 추정 도달: mastery 비율 ≥ 70% 이고 그 학년 개념 수 ≥ 2 인 가장 높은 학년
    let estimate = null;
    for (const g of grades) {
        if (g.ratio >= 0.7 && g.total >= 2) estimate = g;
    }
    return { grades, estimate };
}

// 과거 세션 history + 현재 진행 중인 학습/진단 history 에서
// 학생이 정답한 anchor 중 가장 높은 학년 도출
// (이분 탐색 phase 1 결과 + phase 2 + 학습 모드 anchor 정답 모두 반영)
function computeBracketEstimateFromSessions(sessions) {
    let highestIdx = -1;
    const consider = (hist) => {
        for (const h of (hist || [])) {
            const aIdx = GRADE_ANCHORS.findIndex(a => a.conceptId === h.conceptId);
            if (aIdx >= 0 && h.correct && aIdx > highestIdx) highestIdx = aIdx;
        }
    };
    for (const s of (sessions || [])) consider(s.history);
    // 진행 중(미저장) 데이터도 반영 — "수시로" 학년 추정 갱신
    if (state.practice?.history) consider(state.practice.history);
    if (state.dx?.history) consider(state.dx.history);
    return highestIdx >= 0 ? GRADE_ANCHORS[highestIdx].grade : null;
}

// 마스터 임박 — 한 번만 더 맞히면 mastered 가 되는 개념들
function findAlmostMastered(mastery) {
    const target = MASTERY_THRESHOLD - 1;
    const out = [];
    for (const cid of Object.keys(mastery || {})) {
        const c = state.conceptsById?.[cid];
        if (!c) continue;
        const m = mastery[cid];
        if ((m.correct_streak || 0) === target) {
            out.push({ cid, name: c['개념명'] || cid, grade: c['학년단계'] || '' });
        }
    }
    return out;
}

// 다음 학년 진척 — 현재 추정 학년 바로 위 학년에서 마스터해야 할 개념 수 / 총 개념 수
function findNextGradeProgress(mastery) {
    const { estimate } = estimateGradeLevel(mastery);
    const currentGrade = estimate ? estimate.grade : (computeBracketEstimateFromSessions(state.sessions) ?? 4);
    // 현재 추정보다 높은 학년 중 가장 가까운 학년
    const concepts = state.concepts || [];
    const byGrade = new Map();
    for (const c of concepts) {
        const g = _gradeNum(c['학년단계']);
        if (g === null || g <= currentGrade) continue;
        if (!byGrade.has(g)) byGrade.set(g, []);
        byGrade.get(g).push(c);
    }
    if (byGrade.size === 0) return null;
    const nextGrade = Math.min(...byGrade.keys());
    const list = byGrade.get(nextGrade);
    let mastered = 0;
    for (const c of list) {
        if (getMasteryStatus(mastery?.[c['개념ID']]) === 'mastered') mastered++;
    }
    // 추정 도달 기준: ratio >= 0.7 이고 total >= 2
    const total = list.length;
    const targetMastered = Math.max(2, Math.ceil(total * 0.7));
    const remaining = Math.max(0, targetMastered - mastered);
    return { grade: nextGrade, label: _gradeLabel(nextGrade), mastered, total, targetMastered, remaining };
}

function renderGradeProgress(mastery) {
    const { grades, estimate } = estimateGradeLevel(mastery);
    const bracketGrade = computeBracketEstimateFromSessions(state.sessions);
    if (grades.length === 0 && bracketGrade === null) return '';
    let estimateLine;
    if (estimate) {
        estimateLine = `현재 추정 도달 학년: <b>${estimate.label} 수준</b> (그 학년 개념 ${Math.round(estimate.ratio * 100)}% 마스터)`;
    } else if (bracketGrade !== null) {
        estimateLine = `빠른 추정 학년: <b>${_gradeLabel(bracketGrade)} 수준</b> <span class="meta">(이분 탐색 기반 — 더 풀수록 정확도 향상)</span>`;
    } else {
        estimateLine = `학년 도달 추정 — <span class="meta">아직 70% 마스터한 학년이 없어요</span>`;
    }
    // 학년 다시 추정 링크: 빠른 추정이 있고 학생 화면일 때만
    const showRegradeLink = bracketGrade !== null && state.profile?.role !== 'teacher';
    const regradeLink = showRegradeLink
        ? `<a href="#" class="meta regrade-link" onclick="event.preventDefault(); if (confirm('학년을 처음부터 다시 추정합니다 (이분 탐색 약 3~6 문제). 진행할까요?')) startRegrade();">학년 다시 추정</a>`
        : '';
    return `
        <div class="grade-progress-wrap">
            <div class="grade-estimate">
                🎓 ${estimateLine}
                ${regradeLink ? ` · ${regradeLink}` : ''}
            </div>
            <details class="grade-detail">
                <summary class="meta">학년별 진척도 보기</summary>
                <div class="area-progress">
                    ${grades.map(g => `
                        <div class="area-row">
                            <span class="area-name">${g.label}</span>
                            <div class="area-bar"><div class="area-fill" style="width:${Math.round(g.ratio * 100)}%"></div></div>
                            <span class="area-frac">${g.mastered}/${g.total}</span>
                        </div>
                    `).join('')}
                </div>
            </details>
        </div>
    `;
}

// 매력 오답으로 추정된 (직접 풀어 보지 않은) 개념을 sessions 기록에서 집계.
// "직접 풀이"로 판정 — 두 신호 중 하나라도 있으면 추정에서 제외:
//   (a) mastery 데이터가 있고 total_seen >= 1
//   (b) 세션 history 안에 그 개념을 conceptId 로 가진 항목이 1개라도 있음
// → 어느 한쪽이 동기화 늦어도 다른 쪽으로 잡혀서 약점 추정 누락 없음
function computeSuspectedConcepts(sessions, mastery) {
    const cById = state.conceptsById;

    // (b): 직접 풀어본 적 있는 개념 — sessions 의 conceptId 모두 수집
    const directlyTested = new Set();
    for (const sess of (sessions || [])) {
        for (const h of (sess.history || [])) {
            if (h.conceptId) directlyTested.add(h.conceptId);
        }
    }

    const counts = new Map();
    for (const sess of (sessions || [])) {
        for (const h of (sess.history || [])) {
            if (h.correct) continue;
            const cid = h.inferred;
            if (!cid || !cById[cid]) continue;
            // (a) mastery 로 확인된 직접 풀이
            const m = mastery?.[cid];
            if (m && (m.total_seen || 0) > 0) continue;
            // (b) 세션 history 로 확인된 직접 풀이
            if (directlyTested.has(cid)) continue;
            counts.set(cid, (counts.get(cid) || 0) + 1);
        }
    }
    return [...counts.entries()]
        .map(([cid, count]) => ({ cid, count }))
        .sort((a, b) => b.count - a.count);
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

// 진단 세션 기록을 시간순으로 재생해서 현재 파라미터로 mastery를 새로 계산
function rebuildMasteryFromSessions(sessions) {
    if (!state.user) return {};
    const m = {};
    const sorted = [...sessions].sort((a, b) =>
        new Date(a.finished_at).getTime() - new Date(b.finished_at).getTime()
    );

    for (const sess of sorted) {
        for (const h of (sess.history || [])) {
            const cid = h.conceptId;
            if (!cid) continue;
            if (!m[cid]) {
                m[cid] = {
                    user_id: state.user.id,
                    concept_id: cid,
                    correct_streak: 0,
                    total_seen: 0,
                    total_correct: 0,
                    last_seen_at: null,
                    last_correct_at: null,
                    last_wrong_at: null,
                };
            }
            const e = m[cid];
            const prevStreak = e.correct_streak || 0;
            const newStreak = h.correct
                ? prevStreak + 1
                : Math.max(0, prevStreak - STREAK_DECAY_ON_WRONG);
            const time = sess.finished_at;
            m[cid] = {
                ...e,
                total_seen: (e.total_seen || 0) + 1,
                total_correct: (e.total_correct || 0) + (h.correct ? 1 : 0),
                correct_streak: newStreak,
                last_seen_at: time,
                last_correct_at: h.correct ? time : e.last_correct_at,
                last_wrong_at: h.correct ? e.last_wrong_at : time,
            };
        }
    }
    return m;
}

async function recomputeAndSaveMastery() {
    if (!state.user) return false;
    const { data: sessions, error } = await sb.from('sessions')
        .select('id, finished_at, history')
        .eq('user_id', state.user.id)
        .order('finished_at', { ascending: true });
    if (error) { console.warn('재계산 - sessions 로드 실패', error); return false; }
    if (!sessions || sessions.length === 0) {
        state.mastery = {};
        return false;
    }

    const newMastery = rebuildMasteryFromSessions(sessions);
    const rows = Object.values(newMastery);
    if (rows.length === 0) { state.mastery = {}; return true; }

    try {
        await sb.from('concept_mastery').upsert(rows);
    } catch (e) {
        console.warn('재계산 - mastery 저장 실패', e);
        return false;
    }
    state.mastery = newMastery;
    return true;
}

async function manualRecompute() {
    if (!state.user || state.recomputeBusy) return;
    if (!confirm('지난 진단 기록을 모두 다시 분석해서 현재 상태를 갱신합니다. 계속하시겠습니까?')) return;
    state.recomputeBusy = true;
    state.masteryListFilter = null;
    render();
    const ok = await recomputeAndSaveMastery();
    state.recomputeBusy = false;
    render();
    if (ok) alert('재계산 완료. 현재 상태가 갱신되었어요.');
    else alert('재계산할 진단 기록이 없거나 오류가 있었어요.');
}

function toggleMasteryList(category) {
    if (state.masteryListFilter === category) {
        state.masteryListFilter = null;
    } else {
        state.masteryListFilter = category;
    }
    render();
}

function renderMasteryList(category) {
    const mastery = state.mastery || {};
    const concepts = state.concepts || [];
    const labels = {
        mastered: '🌟 마스터한 개념',
        developing: '📈 학습 중인 개념',
        weak: '⚠️ 약점 개념',
        untouched: '📋 아직 안 풀어본 개념',
        suspected: '🔍 매력 오답으로 추정된 개념',
    };

    let items = [];
    if (category === 'untouched') {
        items = concepts
            .filter(c => !mastery[c['개념ID']] || (mastery[c['개념ID']]?.total_seen || 0) === 0)
            .map(c => ({ cid: c['개념ID'], c, m: null }));
    } else if (category === 'suspected') {
        const suspected = computeSuspectedConcepts(state.sessions, mastery);
        items = suspected.map(({ cid, count }) => ({
            cid, c: state.conceptsById[cid], m: null, suspectedCount: count,
        }));
    } else {
        items = Object.keys(mastery)
            .filter(cid => state.conceptsById[cid])
            .filter(cid => getMasteryStatus(mastery[cid]) === category)
            .filter(cid => (mastery[cid].total_seen || 0) >= 1)
            .map(cid => ({ cid, c: state.conceptsById[cid], m: mastery[cid] }));
        // 약점은 정답률 낮은 순, 마스터/학습중은 최근 본 순
        if (category === 'weak') {
            items.sort((a, b) => {
                const accA = a.m.total_seen ? a.m.total_correct / a.m.total_seen : 0;
                const accB = b.m.total_seen ? b.m.total_correct / b.m.total_seen : 0;
                return accA - accB;
            });
        } else {
            items.sort((a, b) => {
                const ta = a.m.last_seen_at ? new Date(a.m.last_seen_at).getTime() : 0;
                const tb = b.m.last_seen_at ? new Date(b.m.last_seen_at).getTime() : 0;
                return tb - ta;
            });
        }
    }

    if (items.length === 0) {
        return `<div class="mastery-list-detail"><h4>${labels[category]}</h4><p class="meta">해당 개념이 없어요.</p></div>`;
    }

    // 영역별로 그룹화
    const byArea = {};
    for (const it of items) {
        const area = it.c?.['영역'] || '기타';
        if (!byArea[area]) byArea[area] = [];
        byArea[area].push(it);
    }

    return `
        <div class="mastery-list-detail">
            <h4>${labels[category]} (${items.length})</h4>
            <p class="meta">개념을 클릭하면 설명을 볼 수 있어요</p>
            ${Object.entries(byArea).map(([area, list]) => `
                <div class="area-group">
                    <div class="area-group-label">${escapeHTML(area)} (${list.length})</div>
                    <ul class="weakness-list">
                        ${list.map(({ cid, c, m, suspectedCount }) => {
                            const name = c?.['개념명'] || cid;
                            let extra = '';
                            if (m && m.total_seen > 0) {
                                const acc = Math.round((m.total_correct / m.total_seen) * 100);
                                extra = ` · 정답률 ${acc}% · 연속 ${m.correct_streak}회`;
                            } else if (suspectedCount) {
                                extra = ` · 매력 오답 ${suspectedCount}회 시사`;
                            }
                            return `<li class="student-row" onclick="studyConcept('${cid}')">
                                <b>${escapeHTML(name)}</b>
                                <span class="meta">${cid}${extra}</span>
                            </li>`;
                        }).join('')}
                    </ul>
                </div>
            `).join('')}
        </div>
    `;
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

// 문제 풀에서 출제 (정적 CSV 사용)


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

// 개념 그래프 깊이: 선수 개념이 깊을수록 더 상위 개념
const _conceptDepthMemo = {};
function getConceptDepth(cid) {
    if (cid in _conceptDepthMemo) return _conceptDepthMemo[cid];
    const prereqs = getPrereqs(cid);
    if (prereqs.length === 0) {
        _conceptDepthMemo[cid] = 0;
        return 0;
    }
    let maxDepth = 0;
    for (const p of prereqs) {
        const d = getConceptDepth(p);
        if (d > maxDepth) maxDepth = d;
    }
    _conceptDepthMemo[cid] = maxDepth + 1;
    return _conceptDepthMemo[cid];
}

function _conceptGradeNum(cid) {
    const c = state.conceptsById?.[cid];
    return c ? _gradeNum(c['학년단계']) : null;
}

function buildDynamicBattery() {
    // 빠른 추정 학년 — 있으면 학생 학년 ±1 범위로 개념 필터/정렬
    const studentGrade = state.dx?.bracketEstimate
        ?? computeBracketEstimateFromSessions(state.sessions);
    const inGradeBand = (cid) => {
        if (studentGrade === null) return true;
        const g = _conceptGradeNum(cid);
        if (g === null) return true;
        // 학생 학년 + 1 까지 (도전 한 단계 위까지). 그 이상은 너무 어려움.
        return g <= studentGrade + 1;
    };
    const gradeDiff = (cid) => {
        if (studentGrade === null) return 0;
        const g = _conceptGradeNum(cid);
        if (g === null) return 99;
        return Math.abs(g - studentGrade);
    };

    // 1단계: 코어 배터리에서 마스터 안 됐고 학년 범위 내인 것
    let battery = DIAGNOSTIC_BATTERY
        .filter(shouldTestInBattery)
        .filter(inGradeBand);

    // 2단계: 부족하면 보충. 우선순위:
    //   (1) 학생 학년에 가까운 개념
    //   (2) 선수 개념에 약점이 없어 도전 가능한 것
    //   (3) 깊이(상위) 우선
    //   (4) 적게 본 순
    if (battery.length < TARGET_BATTERY_SIZE) {
        const allCids = state.concepts.map(c => c['개념ID']);
        const supplements = allCids
            .filter(cid => !battery.includes(cid))
            .filter(cid => shouldTestInBattery(cid))
            .filter(cid => inGradeBand(cid))
            .filter(cid => {
                const prereqs = getPrereqs(cid);
                return !prereqs.some(p => getMasteryStatus(state.mastery?.[p]) === 'weak');
            })
            .map(cid => ({
                cid,
                gDiff: gradeDiff(cid),
                depth: getConceptDepth(cid),
                seen: state.mastery?.[cid]?.total_seen || 0,
            }))
            .sort((a, b) => {
                if (a.gDiff !== b.gDiff) return a.gDiff - b.gDiff;       // 학생 학년에 가까울수록 우선
                if (b.depth !== a.depth) return b.depth - a.depth;       // 다음으로 깊은(상위) 개념
                return a.seen - b.seen;
            });
        const needed = TARGET_BATTERY_SIZE - battery.length;
        for (const s of supplements.slice(0, needed)) battery.push(s.cid);
    }

    // 모두 마스터 → 무작위 마스터 4개 재검증
    if (battery.length === 0) {
        battery = shuffle([...DIAGNOSTIC_BATTERY]).slice(0, 4);
    }
    if (battery.length > TARGET_BATTERY_SIZE) {
        battery = shuffle(battery).slice(0, TARGET_BATTERY_SIZE);
    }

    return shuffle(battery);
}

function startDiagnosis(opts = {}) {
    state.mode = 'dx';
    const forceRegrade = opts.forceRegrade === true;
    const existingGrade = forceRegrade ? null : computeBracketEstimateFromSessions(state.sessions);
    const skipPhase1 = existingGrade !== null;
    state.dx = {
        phase: skipPhase1 ? 'concept' : 'gradeSearch',
        bracket: skipPhase1 ? null : { low: 0, high: GRADE_ANCHORS.length - 1, lastCorrectIdx: -1, currentMid: null, anchorsAsked: 0 },
        bracketEstimate: existingGrade,  // 기존 추정 그대로 가져감
        queue: skipPhase1 ? buildDynamicBattery() : [],
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

// 학년 다시 추정 — 사용자가 학년 수준이 의심스러울 때 명시적 트리거
function startRegrade() {
    startDiagnosis({ forceRegrade: true });
}

function _finalizeBracketEstimate() {
    const idx = state.dx.bracket.lastCorrectIdx;
    // lastCorrectIdx >= 0 → 그 anchor 학년 수준에 도달
    // -1 (어떤 anchor 도 못 풀음) → 가장 낮은 anchor 학년 미만 (null 로 남김)
    state.dx.bracketEstimate = idx >= 0 ? GRADE_ANCHORS[idx].grade : null;
}

function _transitionToConceptPhase() {
    state.dx.phase = 'concept';
    state.dx.queue = buildDynamicBattery();
}

function nextDxQuestion() {
    state.dx.showingFeedback = false;
    state.dx.selectedIndex = null;
    state.dx.lastInferred = null;

    if (state.dx.history.length >= MAX_DX_QUESTIONS) {
        finishDiagnosis();
        return;
    }

    // Phase 1: 학년 빠른 추정 (이분 탐색)
    if (state.dx.phase === 'gradeSearch') {
        const b = state.dx.bracket;
        if (b.low > b.high || b.anchorsAsked >= GRADE_ANCHORS.length) {
            // 범위 좁혀졌으면 추정 확정 후 phase 2 로 전환
            _finalizeBracketEstimate();
            _transitionToConceptPhase();
            // 아래 phase 2 로직으로 이어짐
        } else {
            const mid = (b.low + b.high) >> 1;
            const anchor = GRADE_ANCHORS[mid];
            // 일관된 난이도 2 로 이분 탐색 (mastery 영향 X)
            const problem = pickProblem(anchor.conceptId, { diagnostic: true, targetLevel: 2 });
            if (problem) {
                b.currentMid = mid;
                state.dx.currentProblem = problem;
                state.dx.currentChoices = buildChoices(problem);
                state.dx.asked.add(problem['문제ID']);
                saveDxToCloud();
                render();
                return;
            } else {
                // anchor 에 풀 문제 없으면 phase 1 종료
                _finalizeBracketEstimate();
                _transitionToConceptPhase();
            }
        }
    }

    // Phase 2: 기존 개념 배터리
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
        // Phase 1 (이분 탐색) 중에는 선수 개념 드릴다운 건너뜀
        if (state.dx.phase === 'concept') {
            for (const pre of getPrereqs(inferred)) {
                const alreadyTested = state.dx.history.some(h => h.conceptId === pre);
                if (state.dx.queue.includes(pre) || alreadyTested) continue;
                // 마스터된 선수 개념은 드릴다운에서 건너뜀 (오개념 의심 안 함)
                const m = state.mastery?.[pre];
                if (m && getMasteryStatus(m) === 'mastered') continue;
                state.dx.queue.push(pre);
            }
        }
    }

    // Phase 1 이분 탐색 bracket 갱신
    if (state.dx.phase === 'gradeSearch') {
        const b = state.dx.bracket;
        const mid = b.currentMid;
        if (correct) {
            b.lastCorrectIdx = mid;
            b.low = mid + 1;
        } else {
            b.high = mid - 1;
        }
        b.anchorsAsked++;
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
    // Phase 1 중에는 드릴다운 건너뜀
    if (state.dx.phase === 'concept') {
        for (const pre of getPrereqs(inferred)) {
            const alreadyTested = state.dx.history.some(h => h.conceptId === pre);
            if (state.dx.queue.includes(pre) || alreadyTested) continue;
            const m = state.mastery?.[pre];
            if (m && getMasteryStatus(m) === 'mastered') continue;
            state.dx.queue.push(pre);
        }
    }
    // Phase 1 이분 탐색 bracket 갱신 (모름 = 오답)
    if (state.dx.phase === 'gradeSearch') {
        const b = state.dx.bracket;
        const mid = b.currentMid;
        b.high = mid - 1;
        b.anchorsAsked++;
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
        // 직접 풀어 'weak' 상태가 된 개념만 추천 대상으로
        // (오답 매핑으로 추론만 됐을 뿐 직접 풀지 않은 미시도 개념 제외)
        const m = state.mastery?.[cid];
        const status = getMasteryStatus(m);
        if (status !== 'weak') continue;
        if (!state.conceptsById[cid]) continue;
        const prereqs = getPrereqs(cid);
        const anyWeakPrereq = prereqs.some(p => weak.has(p) && getMasteryStatus(state.mastery?.[p]) === 'weak');
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
        history: [],                              // 풀이 기록 누적
        startedAt: new Date().toISOString(),
        savedToSessions: false,                   // 중복 저장 방지
    };
    nextPracticeQuestion();
}

function nextPracticeQuestion() {
    state.practice.showingFeedback = false;
    state.practice.selectedIndex = null;
    // 5번 정답 달성 → 더 출제하지 않고 종료 화면으로
    if ((state.practice.correctCount || 0) >= PRACTICE_TARGET_CORRECT) {
        state.practice.currentProblem = null;
        state.practice.currentChoices = [];
        savePracticeToCloud();
        render();
        return;
    }
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
    const problem = state.practice.currentProblem;
    state.practice.showingFeedback = true;
    state.practice.totalCount++;
    if (chosen.isCorrect) state.practice.correctCount++;

    // 학습 풀이 기록도 누적
    state.practice.history.push({
        problemId: problem['문제ID'],
        conceptId: problem['점검개념ID'],
        question: problem['문제'],
        chosenText: chosen.text,
        chosenExplanation: chosen.explanation || '',
        correctAnswer: problem['정답'],
        correct: chosen.isCorrect,
        inferred: chosen.isCorrect ? null : (chosen.weakness || problem['점검개념ID']),
    });

    updateMastery(problem?.['점검개념ID'], chosen.isCorrect);
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

async function savePracticeSession() {
    if (!state.user || !state.practice) return;
    const pr = state.practice;
    if (pr.savedToSessions) return;
    if (!pr.history?.length) return;
    pr.savedToSessions = true;
    try {
        await sb.from('sessions').insert({
            user_id: state.user.id,
            kind: 'practice',
            concept_id: pr.conceptId,
            finished_at: new Date().toISOString(),
            score: pr.correctCount,
            total: pr.totalCount,
            weak_concepts: [],
            root_concepts: [],
            history: pr.history,
        });
        state.practiceCount = (state.practiceCount || 0) + 1;
    } catch (e) {
        console.warn('학습 세션 저장 실패', e);
    }
}

async function backToResult() {
    await savePracticeSession();
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
        state.dx = {
            ...dx,
            asked: new Set(dx.asked || []),
            wrongConcepts: new Set(dx.wrongConcepts || []),
            // 구버전 호환: phase 가 없으면 기존 동적 배터리 흐름으로 (phase 1 건너뜀)
            phase: dx.phase || 'concept',
            bracket: dx.bracket || null,
            bracketEstimate: dx.bracketEstimate ?? null,
        };
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

// 한글/비한글 토큰화 → 수학 chunk 만 KaTeX 렌더
function _isKoreanChar(ch) {
    return /[ㄱ-힝一-鿿]/.test(ch);
}

function _convertMathChunk(s) {
    let t = s;
    // Unicode 위첨자 codepoint 매핑 (명시적 escape — 어떤 입력 인코딩이든 동일하게 매칭)
    // ⁰=2070 ¹=00B9 ²=00B2 ³=00B3 ⁴=2074 ⁵=2075 ⁶=2076 ⁷=2077 ⁸=2078 ⁹=2079 ⁻=207B
    const SUP_DIGIT_CLASS = '[⁰¹²³⁴⁵⁶⁷⁸⁹]';
    const SUP_DIGIT_MAP = {
        '⁰':'0','¹':'1','²':'2','³':'3','⁴':'4',
        '⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9',
    };
    // 위첨자 마이너스 + 위첨자 숫자(여러 자리) → ^{-N}  (예: f⁻¹ → f^{-1})
    t = t.replace(new RegExp('⁻(' + SUP_DIGIT_CLASS + '+)', 'g'), (_, run) => {
        return '^{-' + [...run].map(c => SUP_DIGIT_MAP[c]).join('') + '}';
    });
    // 단독 위첨자 숫자 (연속) → ^{N} (예: x²³ → x^{23})
    t = t.replace(new RegExp(SUP_DIGIT_CLASS + '+', 'g'), run => {
        return '^{' + [...run].map(c => SUP_DIGIT_MAP[c]).join('') + '}';
    });
    // 남은 단독 위첨자 마이너스
    t = t.replace(/⁻/g, '-');
    // 합성·무한 기호
    t = t.replace(/∘/g, '\\circ ');     // ∘
    t = t.replace(/∞/g, '\\infty ');    // ∞
    // 좌표·순서쌍: (a b) → (a, b)   — 콤마 없이 공백으로 구분된 두 항목 처리
    // 3-tuple: (a b c) → (a, b, c) 도 처리
    t = t.replace(/\(([+-]?\d+(?:\.\d+)?|[a-zA-Z])\s+([+-]?\d+(?:\.\d+)?|[a-zA-Z])\s+([+-]?\d+(?:\.\d+)?|[a-zA-Z])\)/g, '($1,\\ $2,\\ $3)');
    t = t.replace(/\(([+-]?\d+(?:\.\d+)?|[a-zA-Z])\s+([+-]?\d+(?:\.\d+)?|[a-zA-Z])\)/g, '($1,\\ $2)');
    // 루트
    t = t.replace(/√\(([^()]+)\)/g, '\\sqrt{$1}');
    t = t.replace(/√(\d+)/g, '\\sqrt{$1}');
    t = t.replace(/√([a-zA-Z])/g, '\\sqrt{$1}');
    // 분수 — 위첨자/√ 변환 후이므로 \sqrt{...}, ^{...}, (...)^{...} 를 한 단위(atom) 로 취급.
    // atom = (계수)?\sqrt{...} | (...)^{...} | (계수)?문자(들) | 숫자  + 뒤에 ^{...} 선택.
    // 계수+변수 (2x, 3xy 등) 도 한 덩어리. 괄호 뒤에 ^ 가 있으면 atom 으로 통째 처리.
    const ATOM = '(?:\\d+\\\\sqrt\\{[^}]+\\}|\\\\sqrt\\{[^}]+\\}|\\([^()]+\\)\\^\\{[^}]+\\}|\\d*[a-zA-Z]+|\\d+)(?:\\^\\{[^}]+\\})?';
    // 괄호 분수 우선 — 괄호 뒤에 ^ 없는 경우만
    t = t.replace(/\(([^()]+)\)(?!\^)\s*\/\s*\(([^()]+)\)(?!\^)/g, '\\frac{$1}{$2}');
    t = t.replace(new RegExp('\\(([^()]+)\\)(?!\\^)\\s*\\/\\s*(' + ATOM + ')', 'g'), '\\frac{$1}{$2}');
    t = t.replace(new RegExp('(' + ATOM + ')\\s*\\/\\s*\\(([^()]+)\\)(?!\\^)', 'g'), '\\frac{$1}{$2}');
    // 단순 분수 (√, (...)^{n} 포함)
    t = t.replace(new RegExp('(' + ATOM + ')\\s*\\/\\s*(' + ATOM + ')(?![\\/\\^])', 'g'), '\\frac{$1}{$2}');
    // 연산자
    t = t.replace(/×/g, '\\times ');
    t = t.replace(/÷/g, '\\div ');
    t = t.replace(/±/g, '\\pm ');
    t = t.replace(/∓/g, '\\mp ');
    t = t.replace(/≤/g, '\\leq ');
    t = t.replace(/≥/g, '\\geq ');
    t = t.replace(/≠/g, '\\neq ');
    t = t.replace(/⋅/g, '\\cdot ');
    t = t.replace(/·/g, '\\cdot ');
    return t;
}

function _tokenize(s) {
    const tokens = [];
    let buf = '';
    let inKorean = false;
    for (const ch of s) {
        const isK = _isKoreanChar(ch);
        if (buf === '') {
            inKorean = isK;
            buf = ch;
        } else if (isK === inKorean) {
            buf += ch;
        } else {
            tokens.push({ korean: inKorean, text: buf });
            buf = ch;
            inKorean = isK;
        }
    }
    if (buf) tokens.push({ korean: inKorean, text: buf });
    return tokens;
}

function _fallbackFormatChunk(s) {
    let t = escapeHTML(s);
    t = t.replace(/√\(([^()]+)\)/g, '√<span class="sqrt-arg">$1</span>');
    t = t.replace(/√(\d+)/g, '√<span class="sqrt-arg">$1</span>');
    t = t.replace(/√([a-zA-Z])/g, '√<span class="sqrt-arg">$1</span>');
    const FRAC_TPL = '<span class="frac"><span class="num">$1</span><span class="den">$2</span></span>';
    t = t.replace(/\(([^()]+)\)\s*\/\s*\(([^()]+)\)/g, FRAC_TPL);
    t = t.replace(/\(([^()]+)\)\s*\/\s*(\d+|[a-zA-Z]+)/g, FRAC_TPL);
    t = t.replace(/(\d+|[a-zA-Z]+)\s*\/\s*\(([^()]+)\)/g, FRAC_TPL);
    t = t.replace(/(\d+|[a-zA-Z]+)\s*\/\s*(\d+|[a-zA-Z]+)(?![\/\^])/g, FRAC_TPL);
    return t;
}

// 한글 텍스트는 그대로(HTML escape), 수학 chunk 만 KaTeX 로 렌더.
// 한글 ↔ 수식 경계에 자동으로 공백 삽입.
function formatMath(s) {
    if (!s) return '';
    const tokens = _tokenize(s);
    let result = '';
    let lastKind = null;

    for (const tok of tokens) {
        let html, kind;
        if (tok.korean) {
            html = escapeHTML(tok.text.trim());
            if (!html) continue;
            kind = 'korean';
        } else {
            const core = tok.text.trim();
            if (!core) continue;
            kind = 'math';
            if (typeof katex === 'undefined') {
                html = _fallbackFormatChunk(core);
            } else {
                const latex = _convertMathChunk(core);
                try {
                    html = katex.renderToString(latex, {
                        throwOnError: false,
                        displayMode: false,
                        output: 'html',
                        strict: false,
                    });
                } catch (e) {
                    html = _fallbackFormatChunk(core);
                }
            }
        }
        // 경계에서만 공백 추가 (한글↔수식 또는 같은 종류라도 한글 사이엔 어차피 자체 공백)
        if (lastKind !== null) result += ' ';
        result += html;
        lastKind = kind;
    }
    return result;
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
        if (!state.conceptsById[cid]) continue; // orphan 안전 처리
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
    // — 직접 풀어 'weak' 가 된 개념만 (미시도/추정만 된 개념 제외)
    const weaknessList = [];
    for (const cid of Object.keys(mastery)) {
        if (!state.conceptsById[cid]) continue;
        const m = mastery[cid];
        if (getMasteryStatus(m) !== 'weak') continue;
        if ((m.total_seen || 0) < 1) continue; // 직접 시도 보장
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
                    <div class="m-stat m-mastered ${state.masteryListFilter === 'mastered' ? 'active' : ''}" onclick="toggleMasteryList('mastered')"><b>${mastered}</b><span>🌟 마스터</span></div>
                    <div class="m-stat m-developing ${state.masteryListFilter === 'developing' ? 'active' : ''}" onclick="toggleMasteryList('developing')"><b>${developing}</b><span>📈 학습 중</span></div>
                    <div class="m-stat m-weak ${state.masteryListFilter === 'weak' ? 'active' : ''}" onclick="toggleMasteryList('weak')"><b>${weak}</b><span>⚠️ 약점</span></div>
                    <div class="m-stat m-untouched ${state.masteryListFilter === 'untouched' ? 'active' : ''}" onclick="toggleMasteryList('untouched')"><b>${untouched}</b><span>📋 미시도</span></div>
                </div>
                ${renderGradeProgress(mastery)}
                ${(() => {
                    const almost = findAlmostMastered(mastery);
                    if (almost.length === 0) return '';
                    const top = almost.slice(0, 3);
                    const more = almost.length - top.length;
                    return `<div class="motivation-card almost-mastered">
                        <div class="motiv-title">⭐ 한 문제만 더 맞히면 마스터!</div>
                        <div class="motiv-list">
                            ${top.map(a => `<button class="motiv-chip" onclick="startPractice('${a.cid}')">${escapeHTML(a.name)}</button>`).join('')}
                            ${more > 0 ? `<span class="motiv-more">외 ${more}개</span>` : ''}
                        </div>
                    </div>`;
                })()}
                ${(() => {
                    const np = findNextGradeProgress(mastery);
                    if (!np) return '';
                    if (np.remaining === 0) {
                        return `<div class="motivation-card next-grade reached">
                            <div class="motiv-title">🎓 <b>${np.label}</b> 도달! · ${np.mastered}/${np.total} 마스터</div>
                            <div class="motiv-sub">계속 풀어 더 위 학년에 도전해보세요</div>
                        </div>`;
                    }
                    const pct = np.targetMastered > 0 ? Math.min(100, Math.round(np.mastered / np.targetMastered * 100)) : 0;
                    return `<div class="motivation-card next-grade">
                        <div class="motiv-title">🎯 다음 학년 <b>${np.label}</b> 까지 <b>${np.remaining}개</b> 더 마스터하면 도달!</div>
                        <div class="motiv-bar"><div class="motiv-fill" style="width:${pct}%"></div></div>
                        <div class="motiv-sub">${np.mastered}/${np.targetMastered} 마스터 (${np.label} 전체 ${np.total}개)</div>
                    </div>`;
                })()}
                ${(() => {
                    const suspected = computeSuspectedConcepts(state.sessions, mastery);
                    if (suspected.length === 0) return '';
                    const open = state.masteryListFilter === 'suspected';
                    return `<div class="suspected-banner ${open ? 'active' : ''}" onclick="toggleMasteryList('suspected')">
                        🔍 매력 오답으로 추정된 개념 <b>${suspected.length}개</b> · 직접 풀어보면 확정 ${open ? '▴' : '▾'}
                    </div>`;
                })()}
                ${state.masteryListFilter ? renderMasteryList(state.masteryListFilter) : ''}

                <details class="area-progress-details">
                    <summary><h3>영역별 진척도</h3></summary>
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
                </details>

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
            ${(sessionCount > 0 || (state.practiceCount || 0) > 0) ? `<button class="block" onclick="viewHistory()">📋 지난 기록 보기 (진단 ${sessionCount}회 · 학습 ${state.practiceCount || 0}회)</button>` : ''}
            ${sessionCount > 0 ? `
                <p class="admin-link-row">
                    <a class="admin-link" onclick="manualRecompute()">
                        ${state.recomputeBusy ? '재계산 중...' : '↻ 지난 진단 기록으로 현재 상태 다시 분석'}
                    </a>
                </p>
            ` : ''}
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
                <div class="meta">진단 ${askedCount}번째 문제 · ${escapeHTML(concept['개념명'])} 점검${dx.phase === 'gradeSearch' ? ' · <span style="color:#0a7">빠른 학년 추정 중</span>' : ''}</div>
                ${dx.bracketEstimate !== null ? `<div class="meta" style="margin-top:4px">📊 빠른 추정: <b>${_gradeLabel(dx.bracketEstimate)} 수준</b> (이후 자세한 진단 진행 중)</div>` : ''}
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
                    <div class="meta">진단 ${askedCount}번째 문제 · ${escapeHTML(concept['개념명'])} 점검${dx.phase === 'gradeSearch' ? ' · <span style="color:#0a7">빠른 학년 추정 중</span>' : ''}</div>
                ${dx.bracketEstimate !== null ? `<div class="meta" style="margin-top:4px">📊 빠른 추정: <b>${_gradeLabel(dx.bracketEstimate)} 수준</b> (이후 자세한 진단 진행 중)</div>` : ''}
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
                <div class="meta">진단 ${askedCount}번째 문제 · ${escapeHTML(concept['개념명'])} 점검${dx.phase === 'gradeSearch' ? ' · <span style="color:#0a7">빠른 학년 추정 중</span>' : ''}</div>
                ${dx.bracketEstimate !== null ? `<div class="meta" style="margin-top:4px">📊 빠른 추정: <b>${_gradeLabel(dx.bracketEstimate)} 수준</b> (이후 자세한 진단 진행 중)</div>` : ''}
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

    // 직접 풀어 mastery 가 'weak' 가 된 개념만 진짜 약점으로 분류
    const allWrong = [...dx.wrongConcepts];
    const weak = allWrong.filter(cid => {
        if (!state.conceptsById[cid]) return false;
        return getMasteryStatus(state.mastery?.[cid]) === 'weak';
    });
    // 매력 오답 매핑으로 추정된 (직접 풀지 않은) 개념은 별도 표시
    const suspected = allWrong.filter(cid => {
        if (!state.conceptsById[cid]) return false;
        return getMasteryStatus(state.mastery?.[cid]) !== 'weak';
    });
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
            ${dx.bracketEstimate !== null ? `<p class="grade-estimate">🎓 빠른 학년 추정: <b>${_gradeLabel(dx.bracketEstimate)} 수준</b> <span class="meta">(이분 탐색 ${GRADE_ANCHORS.length} 개 anchor 중 ${dx.bracket?.anchorsAsked || 0} 문제로 추정)</span></p>` : ''}
            <p class="meta">결과는 ${escapeHTML(getDisplayName())} 님 계정에 저장되었습니다.</p>

            ${weak.length === 0 && suspected.length === 0 ? `
                <p>🎉 큰 약점이 발견되지 않았어요.</p>
            ` : `
                ${weak.length > 0 ? `
                    <h3>약점 개념 (${weak.length}개)</h3>
                    <p class="meta">직접 풀어서 틀린 개념입니다.</p>
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

                    ${roots.length > 0 ? `
                        <h3>🌱 추천 시작 개념</h3>
                        <p>아래 개념부터 학습하시면 위쪽 약점들이 함께 풀려요. 개념 설명을 먼저 보고 문제를 풀 수 있어요.</p>
                        ${roots.map(cid => {
                            const c = state.conceptsById[cid];
                            if (!c) return '';
                            return `<button class="primary block" onclick="studyConcept('${cid}')">📖 ${escapeHTML(c['개념명'])} 개념 보기</button>`;
                        }).join('')}
                    ` : ''}
                ` : ''}

                ${suspected.length > 0 ? `
                    <h3 style="margin-top:24px">🔍 확인이 필요한 개념 (${suspected.length}개)</h3>
                    <p class="meta">매력 오답을 골라 시사된 개념이지만 직접 풀지 않았어요. 다음 진단에서 직접 풀어봐야 약점 여부가 확정됩니다.</p>
                    <ul class="weakness-list">
                        ${suspected.map(cid => {
                            const c = state.conceptsById[cid];
                            if (!c) return '';
                            return `<li>
                                <b>${escapeHTML(c['개념명'])}</b>
                                <span class="meta">${cid} · ${escapeHTML(c['영역'])}</span>
                            </li>`;
                        }).join('')}
                    </ul>
                ` : ''}
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
        const reached = (pr.correctCount || 0) >= PRACTICE_TARGET_CORRECT;
        const headline = reached
            ? `🎉 ${PRACTICE_TARGET_CORRECT}문제 정답 달성!`
            : `📚 ${escapeHTML(concept['개념명'])} 학습 종료`;
        const message = reached
            ? `${escapeHTML(concept['개념명'])} 개념을 충분히 익혔어요. 다른 학습으로 넘어가도 좋아요.`
            : `이번 학습 회차가 끝났어요. 점수가 부족하면 다시 한 번 시도해 보세요.`;
        return `
            <div class="card">
                <h2>${headline}</h2>
                <p>${message}</p>
                <p>점수: <b>${pr.correctCount} / ${pr.totalCount}</b></p>
                <button class="primary block" onclick="backToResult()">결과 화면으로</button>
            </div>
        `;
    }

    const isCorrect = pr.showingFeedback && pr.selectedIndex !== null && pr.currentChoices[pr.selectedIndex].isCorrect;

    if (!pr.showingFeedback) {
        return `
            <div class="card">
                <div class="meta">학습 중: ${escapeHTML(concept['개념명'])} · 난이도 ${escapeHTML(p['난이도'])} · 정답 ${pr.correctCount}/${PRACTICE_TARGET_CORRECT}</div>
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
                    <div class="meta">학습 중: ${escapeHTML(concept['개념명'])} · 난이도 ${escapeHTML(p['난이도'])} · 정답 ${pr.correctCount}/${PRACTICE_TARGET_CORRECT}</div>
                    <div class="problem">${formatMath(p['문제'])}</div>
                    ${renderChoices(pr.currentChoices, pr.selectedIndex, true, 'selectPracticeChoice')}
                    <div class="correct correct-flash">✓ 정답입니다!</div>
                    <div class="auto-advance">잠시 후 다음 문제로 넘어갑니다...</div>
                </div>
            `;
        }
        return `
            <div class="card">
                <div class="meta">학습 중: ${escapeHTML(concept['개념명'])} · 난이도 ${escapeHTML(p['난이도'])} · 정답 ${pr.correctCount}/${PRACTICE_TARGET_CORRECT}</div>
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
    const diagCount = list.filter(s => s.kind !== 'practice').length;
    const prCount = list.filter(s => s.kind === 'practice').length;
    return `
        <div class="card">
            <h2>📋 지난 기록</h2>
            <p class="meta">진단 ${diagCount}회 · 학습 ${prCount}회</p>
            <ul class="weakness-list">
                ${list.map(sess => {
                    const isPractice = sess.kind === 'practice';
                    const conceptName = isPractice && sess.concept_id
                        ? (state.conceptsById[sess.concept_id]?.['개념명'] || sess.concept_id)
                        : null;
                    const label = isPractice ? `📚 학습: ${escapeHTML(conceptName || '')}` : '📊 진단';
                    return `<li onclick="viewPastSession(${sess.id})" style="cursor:pointer">
                        <b>${formatDate(sess.finished_at)}</b>
                        <span class="meta"> · ${label} · 점수 ${sess.score}/${sess.total}${isPractice ? '' : ' · 약점 ' + (sess.weak_concepts || []).length + '개'}</span>
                    </li>`;
                }).join('')}
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
    const isPractice = sess.kind === 'practice';
    const weak = sess.weak_concepts || [];
    const roots = sess.root_concepts || [];
    let studentLabel = '';
    if (isTeacher && state.viewStudentId && state.teacherData) {
        const stu = state.teacherData.students.find(s => s.id === state.viewStudentId);
        if (stu) studentLabel = `<p class="meta">${escapeHTML(stu.username)} 학생</p>`;
    }
    const conceptName = isPractice && sess.concept_id
        ? (state.conceptsById[sess.concept_id]?.['개념명'] || sess.concept_id)
        : null;
    return `
        <div class="card">
            <h2>${isPractice ? '📚' : '📊'} ${formatDate(sess.finished_at)} ${isPractice ? '학습' : '진단'}</h2>
            ${studentLabel}
            ${isPractice && conceptName ? `<p class="meta">개념: ${escapeHTML(conceptName)}</p>` : ''}
            <p>점수: <b>${sess.score} / ${sess.total}</b></p>
            ${!isPractice && weak.length > 0 ? `
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
            ` : ''}
            ${!isPractice && weak.length === 0 ? '<p>큰 약점이 없었어요.</p>' : ''}
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

function toggleClassConcept(kind, cid) {
    const cur = state.expandedClassConcept;
    if (cur && cur.kind === kind && cur.cid === cid) {
        state.expandedClassConcept = null;
    } else {
        state.expandedClassConcept = { kind, cid };
    }
    render();
}

function findStudentsForClassConcept(kind, cid) {
    const td = state.teacherData;
    if (!td) return [];
    return td.students.filter(stu => {
        if (kind === 'weak') {
            const m = td.masteryByUser?.[stu.id]?.[cid];
            return m && getMasteryStatus(m) === 'weak';
        } else if (kind === 'suspected') {
            const susp = td.suspectedByUser?.[stu.id] || [];
            return susp.some(s => s.cid === cid);
        }
        return false;
    });
}

function _renderStudentSublist(students) {
    if (!students || students.length === 0) {
        return '<div class="student-sublist-empty">해당 학생 없음</div>';
    }
    return `<ul class="student-sublist" onclick="event.stopPropagation()">
        ${students.map(stu => `
            <li onclick="viewStudent('${stu.id}')">
                <b>${escapeHTML(stu.username)}</b>
                <span class="meta">진단 ${stu.sessionCount}회 · 약점 ${stu.uniqueWeakCount}개</span>
            </li>
        `).join('')}
    </ul>`;
}

async function viewStudent(userId) {
    state.viewStudentId = userId;
    state.mode = 'teacherStudent';
    render();
    // 학생 상세 진입 시 항상 최신 데이터 가져오기 (학생이 그동안 푼 결과 반영)
    try {
        await loadTeacherData();
        render();
    } catch (e) { console.warn('teacher refresh failed', e); }
}

async function backToTeacherDashboard() {
    state.mode = 'welcome';
    state.viewStudentId = null;
    state.viewSession = null;
    render();
    try {
        await loadTeacherData();
        render();
    } catch (e) { console.warn('teacher refresh failed', e); }
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

    // 반 전체 추정 약점 — 학생별 추정 합산 (학생 수 기준)
    const studentsBySuspected = {};
    for (const stu of td.students) {
        const sList = td.sessionsByUser.get(stu.id) || [];
        const sm = td.masteryByUser?.[stu.id] || {};
        const suspected = computeSuspectedConcepts(sList, sm);
        for (const { cid } of suspected) {
            studentsBySuspected[cid] = (studentsBySuspected[cid] || 0) + 1;
        }
    }
    const classSuspected = Object.entries(studentsBySuspected)
        .map(([cid, count]) => ({ cid, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

    return `
        <div class="card">
            <div class="header-row">
                <h1>👨‍🏫 ${escapeHTML(getDisplayName())} 선생님</h1>
                <button class="link-btn" onclick="doLogout()">로그아웃</button>
            </div>

            <div class="stats-row">
                <div class="stat"><b>${studentCount}</b><span class="meta">학생</span></div>
                <div class="stat"><b>${totalSessions}</b><span class="meta">진단 누적</span></div>
                <div class="stat"><b>${td.classWeak.length}</b><span class="meta">현재 약점 개념</span></div>
            </div>

            <button class="link-btn" onclick="refreshTeacherData()" style="float:right;margin-top:-8px">↻ 새로고침</button>

            <button class="block" onclick="viewProblemBank()" style="margin-top:8px">📚 문제 은행 둘러보기</button>

            ${top.length === 0 ? `
                <p class="meta">아직 진단 데이터가 없어요.</p>
            ` : `
                <details class="dash-section">
                    <summary>🔥 현재 우리반이 어려워하는 개념 (${top.length}개) <span class="hint">— 클릭하여 펼치기</span></summary>
                    <p class="meta">개념을 클릭하면 그 개념을 약점으로 가진 학생 목록이 펼쳐져요</p>
                    <ul class="weakness-list">
                        ${top.map((w, i) => {
                            const c = state.conceptsById[w.cid];
                            const name = c ? c['개념명'] : w.cid;
                            const pct = studentCount > 0 ? Math.round((w.count / studentCount) * 100) : 0;
                            const exp = state.expandedClassConcept;
                            const isOpen = exp && exp.kind === 'weak' && exp.cid === w.cid;
                            const sublist = isOpen
                                ? _renderStudentSublist(findStudentsForClassConcept('weak', w.cid))
                                : '';
                            return `<li class="clickable-concept ${isOpen ? 'open' : ''}" onclick="toggleClassConcept('weak', '${w.cid}')">
                                <b>${i+1}. ${escapeHTML(name)}</b>
                                <span class="meta">— ${w.count}명 (${pct}%) ${isOpen ? '▴' : '▾'}</span>
                                <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
                                ${sublist}
                            </li>`;
                        }).join('')}
                    </ul>
                </details>
            `}

            ${classSuspected.length > 0 ? `
                <details class="dash-section">
                    <summary>🔍 매력 오답으로 추정된 개념 (${classSuspected.length}개) <span class="hint">— 미시도 · 클릭하여 펼치기</span></summary>
                    <p class="meta">학생들이 매력 오답을 골라 시사된 개념. 개념 클릭하면 학생 목록 표시.</p>
                    <ul class="weakness-list">
                        ${classSuspected.map((w, i) => {
                            const c = state.conceptsById[w.cid];
                            const name = c ? c['개념명'] : w.cid;
                            const pct = studentCount > 0 ? Math.round((w.count / studentCount) * 100) : 0;
                            const exp = state.expandedClassConcept;
                            const isOpen = exp && exp.kind === 'suspected' && exp.cid === w.cid;
                            const sublist = isOpen
                                ? _renderStudentSublist(findStudentsForClassConcept('suspected', w.cid))
                                : '';
                            return `<li class="clickable-concept ${isOpen ? 'open' : ''}" onclick="toggleClassConcept('suspected', '${w.cid}')">
                                <b>${i+1}. ${escapeHTML(name)}</b>
                                <span class="meta">— ${w.count}명 (${pct}%) ${isOpen ? '▴' : '▾'}</span>
                                <div class="bar"><div class="bar-fill" style="width:${pct}%; background:#a8a8a8"></div></div>
                                ${sublist}
                            </li>`;
                        }).join('')}
                    </ul>
                </details>
            ` : ''}

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

    // 학생 mastery 정보 (orphan 개념 제외)
    const sm = td.masteryByUser?.[sid] || {};
    const masteryByStatus = { mastered: [], developing: [], weak: [], unknown: [] };
    for (const cid of Object.keys(sm)) {
        if (!state.conceptsById[cid]) continue;
        const status = getMasteryStatus(sm[cid]);
        masteryByStatus[status].push({ cid, m: sm[cid] });
    }
    // 현재 약점 — 정답률 낮은 순
    const currentWeak = masteryByStatus.weak
        .map(({ cid, m }) => ({
            cid, m,
            acc: m.total_seen ? m.total_correct / m.total_seen : 0,
        }))
        .sort((a, b) => a.acc - b.acc);

    return `
        <div class="card">
            <div class="header-row">
                <h2>👤 ${escapeHTML(student.username)} 학생</h2>
                <button class="link-btn" onclick="backToTeacherDashboard()">← 대시보드</button>
            </div>
            ${(() => {
                const dxList = studentSessions.filter(s => s.kind !== 'practice');
                const prList = studentSessions.filter(s => s.kind === 'practice');
                const totalSeen = studentSessions.reduce((sum, s) => sum + s.total, 0);
                const totalCorrect = studentSessions.reduce((sum, s) => sum + s.score, 0);
                const avg = totalSeen > 0 ? Math.round(totalCorrect / totalSeen * 100) + '%' : '—';
                return `<p class="meta">진단 ${dxList.length}회 · 학습 ${prList.length}회 · 평균 정답률 ${avg}</p>`;
            })()}

            ${(masteryByStatus.mastered.length + masteryByStatus.developing.length + masteryByStatus.weak.length) > 0 ? `
                <div class="mastery-summary">
                    <div class="m-stat m-mastered"><b>${masteryByStatus.mastered.length}</b><span>🌟 마스터</span></div>
                    <div class="m-stat m-developing"><b>${masteryByStatus.developing.length}</b><span>📈 학습 중</span></div>
                    <div class="m-stat m-weak"><b>${masteryByStatus.weak.length}</b><span>⚠️ 약점</span></div>
                </div>
                ${renderGradeProgress(sm)}
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

            ${studentSessions.length === 0 ? '<p>아직 진단 데이터가 없어요.</p>' : `
                ${currentWeak.length > 0 ? `
                    <h3>⚠️ 현재 어려움을 겪는 개념 (${currentWeak.length}개)</h3>
                    <p class="meta">직접 풀어 mastery 가 weak 가 된 개념. 정답률 낮은 순.</p>
                    <ul class="weakness-list">
                        ${currentWeak.map(({ cid, m, acc }) => {
                            const c = state.conceptsById[cid];
                            const name = c ? c['개념명'] : cid;
                            return `<li>
                                <b>${escapeHTML(name)}</b>
                                <span class="meta">${cid} · 정답률 ${Math.round(acc * 100)}% (${m.total_correct}/${m.total_seen}) · 연속 ${m.correct_streak}회</span>
                            </li>`;
                        }).join('')}
                    </ul>
                ` : '<p class="meta">현재 어려움을 겪는 개념이 없어요. 잘하고 있어요!</p>'}

                ${(() => {
                    const susp = computeSuspectedConcepts(studentSessions, sm);
                    if (susp.length === 0) return '';
                    return `
                        <h3>🔍 매력 오답으로 추정된 개념 (${susp.length}개)</h3>
                        <p class="meta">학생이 매력 오답을 골라 시사된 개념. 직접 풀이로 확정된 데이터는 없음.</p>
                        <ul class="weakness-list">
                            ${susp.map(({ cid, count }) => {
                                const c = state.conceptsById[cid];
                                const name = c ? c['개념명'] : cid;
                                return `<li>
                                    <b>${escapeHTML(name)}</b>
                                    <span class="meta">${cid} · 매력 오답 ${count}회 시사</span>
                                </li>`;
                            }).join('')}
                        </ul>
                    `;
                })()}

                <h3>풀이 이력 (진단 + 학습)</h3>
                <ul class="weakness-list">
                    ${studentSessions.map(s => {
                        const isPr = s.kind === 'practice';
                        const cName = isPr && s.concept_id
                            ? (state.conceptsById[s.concept_id]?.['개념명'] || s.concept_id)
                            : null;
                        const tag = isPr ? `📚 학습: ${escapeHTML(cName || '')}` : '📊 진단';
                        return `<li class="student-row" onclick="viewStudentSession(${s.id})">
                            <b>${formatDate(s.finished_at)}</b>
                            <span class="meta"> · ${tag} · 점수 ${s.score}/${s.total}${isPr ? '' : ' · 약점 ' + (s.weak_concepts || []).length + '개'}</span>
                        </li>`;
                    }).join('')}
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
                <div class="example-box">
                    ${example.split(/\s+\/\s+/).map(ex => ex.trim()).filter(Boolean).map(ex =>
                        `<div class="example-item">${formatMath(ex)}</div>`
                    ).join('')}
                </div>
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
                ${c['예시'] ? `<br><br><b>예시:</b><div style="margin-top:6px">
                    ${c['예시'].split(/\s+\/\s+/).map(ex => ex.trim()).filter(Boolean).map(ex =>
                        `<div class="example-item">${formatMath(ex)}</div>`
                    ).join('')}
                </div>` : ''}
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
