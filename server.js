const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ==========================================
// [중앙 데이터베이스 모듈] PC & 모바일 실시간 동기화
// ==========================================
const DB_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DB_DIR, 'database.json');

const INITIAL_DB = {
  projects: [
    {
      id: 1,
      name: '토성초등학교 공간재구조화 및 리모델링공사',
      managerEmail: 'site_toseong@example.com',
      supervisorName: '홍길동',
      plans: [
        {
          floor: '1층',
          url: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=800&q=80',
          filename: 'plan_1f.jpg',
        },
        {
          floor: '2층',
          url: 'https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=800&q=80',
          filename: 'plan_2f.jpg',
        },
      ],
    },
  ],
  issues: [
    {
      id: 101,
      projectId: 1,
      projectName: '토성초등학교 공간재구조화 및 리모델링공사',
      supervisorName: '홍길동',
      category: '품질 관리',
      floor: '2층',
      floorPlanUrl: 'https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=800&q=80',
      pin: { x: 45, y: 35 },
      photoUrl: 'https://images.unsplash.com/photo-1504307651254-35680f356dfd?auto=format&fit=crop&w=800&q=80',
      content: '2층 복도 단차 부위 마감 몰탈 불량 및 재료분리대 수평 오차 발생. 전면 재시공 요망.',
      createdAt: '2026-11-04 (수)',
      weather: { condition: '맑음', high: '19', low: '9' },
      isSent: false,
    },
  ],
};

function readDb() {
  try {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(INITIAL_DB, null, 2), 'utf-8');
      return INITIAL_DB;
    }
    const data = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('DB 읽기 오류:', err);
    return INITIAL_DB;
  }
}

function writeDb(data) {
  try {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('DB 쓰기 오류:', err);
  }
}

if (!process.env.GEMINI_API_KEY) {
  console.warn('⚠️ GEMINI_API_KEY 환경변수가 설정되지 않았습니다.');
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const createEmailTransporter = () => {
  const host = (process.env.SMTP_HOST || '').toLowerCase();

  // 1. 네이버 메일인 경우 (네이버 전용 SSL 465 포트 강제 적용)
  if (host.includes('naver')) {
    return nodemailer.createTransport({
      service: 'naver',
      host: 'smtp.naver.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      tls: {
        rejectUnauthorized: false,
      },
    });
  }

  // 2. 구글 지메일인 경우
  if (host.includes('gmail')) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  // 3. Ethereal 및 일반 SMTP
  const port = Number(process.env.SMTP_PORT) || 465;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: port,
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: {
      rejectUnauthorized: false,
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
};

const transporter = createEmailTransporter();

// ==========================================
// [API 0-1] 중앙 데이터 조회 (현장 목록 & 지적 대장)
// ==========================================
app.get('/api/data', (req, res) => {
  try {
    const db = readDb();
    res.json({ success: true, projects: db.projects || [], issues: db.issues || [] });
  } catch (err) {
    console.error('데이터 조회 오류:', err);
    res.status(500).json({ success: false, error: '데이터 조회 실패' });
  }
});

// [API 0-2] 현장 정보 저장/수정 동기화
app.post('/api/projects', (req, res) => {
  const project = req.body;
  if (!project || !project.name) {
    return res.status(400).json({ success: false, message: '현장 정보가 올바르지 않습니다.' });
  }

  try {
    const db = readDb();
    const existingIndex = db.projects.findIndex((p) => p.id === project.id);
    if (existingIndex !== -1) {
      db.projects[existingIndex] = project;
    } else {
      db.projects.push(project);
    }
    writeDb(db);
    console.log(`[현장 동기화 완료]: ${project.name}`);
    res.json({ success: true, projects: db.projects });
  } catch (err) {
    console.error('현장 저장 오류:', err);
    res.status(500).json({ success: false, error: '현장 저장 실패' });
  }
});

// [API 0-3] 지적사항 등록/수정 동기화
app.post('/api/issues', (req, res) => {
  const issue = req.body;
  if (!issue || !issue.projectName) {
    return res.status(400).json({ success: false, message: '지적 정보가 올바르지 않습니다.' });
  }

  try {
    const db = readDb();
    const existingIndex = db.issues.findIndex((i) => i.id === issue.id);
    if (existingIndex !== -1) {
      db.issues[existingIndex] = issue;
    } else {
      db.issues.unshift(issue);
    }
    writeDb(db);
    console.log(`[지적사항 동기화 완료]: ID ${issue.id} - ${issue.projectName}`);
    res.json({ success: true, issues: db.issues });
  } catch (err) {
    console.error('지적사항 저장 오류:', err);
    res.status(500).json({ success: false, error: '지적사항 저장 실패' });
  }
});

// [API 0-4] 현장 삭제 동기화
app.delete('/api/projects/:id', (req, res) => {
  const id = Number(req.params.id);
  try {
    const db = readDb();
    db.projects = (db.projects || []).filter((p) => p.id !== id);
    writeDb(db);
    console.log(`[현장 삭제 완료]: ID ${id}`);
    res.json({ success: true, projects: db.projects });
  } catch (err) {
    console.error('현장 삭제 오류:', err);
    res.status(500).json({ success: false, error: '현장 삭제 실패' });
  }
});

// [API 0] 카카오 OAuth 인가 코드 처리 및 로그인
app.post('/api/auth/kakao', async (req, res) => {
  const { code, redirectUri } = req.body;
  if (!code) {
    return res.status(400).json({ success: false, message: '인가 코드가 전달되지 않았습니다.' });
  }

  const finalRedirectUri = redirectUri || process.env.KAKAO_REDIRECT_URI;
  const restApiKey = process.env.KAKAO_REST_API_KEY;

  if (!restApiKey) {
    return res.status(500).json({ success: false, message: '서버에 카카오 REST API 키(KAKAO_REST_API_KEY)가 설정되지 않았습니다.' });
  }

  try {
    // 1. 카카오 토큰 발급 요청
    const tokenResponse = await axios.post(
      'https://kauth.kakao.com/oauth/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: restApiKey.trim(),
        redirect_uri: finalRedirectUri,
        code: code,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' } }
    );

    const accessToken = tokenResponse.data.access_token;

    // 2. 사용자 프로필(닉네임) 조회
    const userResponse = await axios.get('https://kapi.kakao.com/v2/user/me', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      },
    });

    const kakaoAccount = userResponse.data.kakao_account;
    const nickname =
      kakaoAccount?.profile?.nickname ||
      userResponse.data.properties?.nickname ||
      '공사감독관';
    const userId = userResponse.data.id;

    console.log(`[카카오 로그인 성공] 사용자: ${nickname} (${userId})`);

    res.json({
      success: true,
      user: {
        id: userId,
        nickname: nickname,
      },
    });
  } catch (error) {
    const kakaoError = error.response?.data || error.message;
    console.error('[카카오 인증 처리 오류]:', kakaoError);
    res.status(500).json({
      success: false,
      error: typeof kakaoError === 'object' ? JSON.stringify(kakaoError) : kakaoError,
    });
  }
});

// [API 1] 현장 음성 구두 메모 -> 공사감독일지 지시사항 문장 AI 정제
app.post('/api/ai-refine', async (req, res) => {
  const { category = '일반', memo } = req.body;
  if (!memo || !memo.trim()) {
    return res.status(400).json({ success: false, message: '메모 내용이 없습니다.' });
  }

  const apiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/['"\r\n\t]/g, '');
  if (!apiKey) {
    console.error('❌ GEMINI_API_KEY 환경변수가 설정되지 않았습니다.');
    return res.status(500).json({ success: false, error: '서버에 GEMINI_API_KEY가 설정되지 않았습니다.' });
  }

  try {
    const aiInstance = new GoogleGenerativeAI(apiKey);
    // 최신 지원 모델 목록 우선순위 시도 (gemini-3.1-flash-lite 권장)
    const candidateModels = [
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash',
      'gemini-flash-latest',
    ];

    const prompt = `
당신은 교육청 학교시설공사 공사감독관입니다.
현장에서 감독관이 음성 또는 텍스트로 남긴 거친 구두 메모를 정식 [공사감독일지]의 '업무 내용 및 지시사항' 규격에 맞게 격식 있고 단호한 문장으로 다듬어주세요.

- 지적 구분: ${category}
- 현장 메모 원문: "${memo}"

[작성 지침 - 절대 준수]
1. 불필요한 설명, 인사말, 선택 옵션, 마크다운 기호(따옴표, 볼드 ** 표시) 없이 '오직 최종 공문 지시사항 문장'만 2~3문장으로 출력하세요.
2. 단호하고 명확한 공문서체(~할 것을 지시함, ~즉시 조치 요망, ~작업 중지 지시 등)를 사용하세요.
    `.trim();

    let refinedText = '';
    let lastError = null;

    for (const modelName of candidateModels) {
      try {
        const model = aiInstance.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        refinedText = result.response.text().trim();
        if (refinedText) break;
      } catch (err) {
        lastError = err;
        console.warn(`[Gemini] ${modelName} 시도 실패, 다음 모델로 대체:`, err.message);
      }
    }

    if (!refinedText) {
      throw lastError || new Error('모든 Gemini 모델 응답 실패');
    }

    console.log('[AI 정제 성공]:', refinedText);
    res.json({ success: true, text: refinedText });
  } catch (error) {
    console.error('[Gemini AI 요약 오류]:', error);
    res.status(500).json({
      success: false,
      error: `AI 정제 실패: ${error.message || 'Gemini API 오류'}`,
    });
  }
});

// [API 2] A4 규격 공사감독일지 PDF 첨부 이메일 발송
app.post('/api/send-email', async (req, res) => {
  const { toEmail, projectName = '미지정 공사', date, category = '일반', content = '', pdfBase64 } = req.body;

  if (!toEmail) {
    return res.status(400).json({ success: false, message: '수신자 이메일이 지정되지 않았습니다.' });
  }

  // 날짜 안전 처리 (문자열이 아니거나 유효하지 않을 경우 현재 날짜 사용)
  const safeDate = (typeof date === 'string' && date.length >= 10)
    ? date.slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  // 파일명에 사용 불가능한 특수문자 제거
  const safeProjectName = String(projectName).replace(/[\\/:*?"<>|]/g, '_');

  // Base64 순수 데이터 추출 (jsPDF의 'data:application/pdf;filename=...;base64,' 접두사 완벽 제거)
  let cleanBase64 = String(pdfBase64 || '').trim();
  const commaIdx = cleanBase64.indexOf(',');
  if (commaIdx !== -1 && cleanBase64.startsWith('data:')) {
    cleanBase64 = cleanBase64.substring(commaIdx + 1).trim();
  }

  console.log(`[PDF 첨부파일 디버그] 순수 Base64 길이: ${cleanBase64.length}자 (약 ${(cleanBase64.length * 0.75 / 1024).toFixed(1)} KB)`);

  // 1. Resend API 키가 설정되어 있는 경우 (Render 무료 플랜 권장: HTTPS 443 포트)
  if (process.env.RESEND_API_KEY) {
    try {
      const resendPayload = {
        from: process.env.RESEND_FROM || '공사감독시스템 <onboarding@resend.dev>',
        to: [toEmail],
        subject: `[공사감독일지 시정지시] ${projectName} (${category}) - ${safeDate}`,
        text: `
안녕하십니까, 현장소장님.

[${projectName}] 현장 공사감독일지 및 현장 지적사항을 통보합니다.
상세 지적 위치와 현장 사진이 포함된 정식 공사감독일지는 첨부된 PDF 파일을 확인하시기 바랍니다.

■ 공사명: ${projectName}
■ 점검일자: ${safeDate}
■ 지적구분: ${category}
■ 주요 업무 내용 및 지시사항:
${content}

상기 지적사항에 대하여 즉시 안전 및 품질 기준에 적합하게 시정 조치하시기 바랍니다.
        `.trim(),
        attachments: cleanBase64 ? [
          {
            filename: `공사감독일지_${safeProjectName}_${safeDate}.pdf`,
            content: cleanBase64,
          }
        ] : [],
      };

      // 키에 들어갈 수 있는 공백, 줄바꿈, 따옴표, 중복 Bearer 완벽 제거
      const rawKey = String(process.env.RESEND_API_KEY || '').trim();
      const resendApiKey = rawKey
        .replace(/^Bearer\s+/i, '')
        .replace(/['"\r\n\t]/g, '')
        .trim();

      console.log(`[Resend 발송 시도] API 키 앞 5자리: ${resendApiKey.slice(0, 5)}..., 전체 길이: ${resendApiKey.length}자`);

      const resendRes = await axios.post('https://api.resend.com/emails', resendPayload, {
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
      });

      console.log('[Resend 이메일 발송 성공] ID:', resendRes.data?.id);
      return res.json({
        success: true,
        message: '이메일 및 A4 PDF 첨부 발송 완료 (Resend API)',
        id: resendRes.data?.id,
      });
    } catch (resendErr) {
      const errDetail = resendErr.response?.data || resendErr.message;
      console.error('[Resend 발송 오류]:', errDetail);
      const errMsg = errDetail?.message || JSON.stringify(errDetail);
      return res.status(500).json({ success: false, error: 'Resend 발송 실패: ' + errMsg });
    }
  }

  // 2. 기존 SMTP 전송 방식 (Resend 키가 없을 때 fallback)
  const attachments = [];
  if (cleanBase64) {
    try {
      attachments.push({
        filename: `공사감독일지_${safeProjectName}_${safeDate}.pdf`,
        content: Buffer.from(cleanBase64, 'base64'),
        contentType: 'application/pdf',
      });
    } catch (parseErr) {
      console.warn('PDF Base64 변환 경고:', parseErr.message);
    }
  }

  try {
    const mailOptions = {
      from: `"교육청 공사감독관" <${process.env.SMTP_USER}>`,
      to: toEmail,
      subject: `[공사감독일지 시정지시] ${projectName} (${category}) - ${safeDate}`,
      text: `
안녕하십니까, 현장소장님.

[${projectName}] 현장 공사감독일지 및 현장 지적사항을 통보합니다.
상세 지적 위치와 현장 사진이 포함된 정식 공사감독일지는 첨부된 PDF 파일을 확인하시기 바랍니다.

■ 공사명: ${projectName}
■ 점검일자: ${safeDate}
■ 지적구분: ${category}
■ 주요 업무 내용 및 지시사항:
${content}

상기 지적사항에 대하여 즉시 안전 및 품질 기준에 적합하게 시정 조치하시기 바랍니다.
      `.trim(),
      attachments,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('[이메일 발송 성공] 메시지 ID:', info.messageId);

    // Ethereal 가상 메일인 경우 미리보기 URL 로깅
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
      console.log('📬 Ethereal 이메일 미리보기 URL:', previewUrl);
    }

    res.json({
      success: true,
      message: '이메일 및 A4 PDF 첨부 발송 완료',
      previewUrl: previewUrl || undefined,
    });
  } catch (error) {
    console.error('이메일 전송 오류:', error);
    res.status(500).json({ success: false, error: '이메일 발송 실패: ' + error.message });
  }
});

// 전역 에러 핸들러
app.use((err, req, res, next) => {
  console.error('서버 미처리 예외:', err);
  res.status(500).json({ success: false, message: '서버 내부 오류가 발생했습니다.' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(`[공사감독 백엔드 서버 구동 완료] 포트: ${PORT}`);
  console.log(`=========================================`);
});
