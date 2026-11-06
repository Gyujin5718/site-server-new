const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

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

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const prompt = `
당신은 교육청 학교시설공사 공사감독관입니다.
현장에서 감독관이 음성으로 남긴 거친 구두 메모를 정식 [공사감독일지]의 '업무 내용 및 지시사항' 규격에 맞게 격식 있는 문장으로 다듬어주세요.

- 지적 구분: ${category}
- 현장 메모 원문: "${memo}"

[작성 지침]
1. 2~3문장 이내로 간결하고 단호한 지시문체(~할 것을 지시함, ~조치 요망, ~재시공 지시 등)를 사용하세요.
2. 불필요한 설명, 인사말, 마크다운 기호 없이 최종 정제된 문장만 출력하세요.
    `;

    const result = await model.generateContent(prompt);
    const refinedText = result.response.text().trim();
    res.json({ success: true, text: refinedText });
  } catch (error) {
    console.error('AI 요약 오류:', error);
    res.status(500).json({ success: false, error: 'AI 문장 정제 중 오류가 발생했습니다.' });
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
  const cleanBase64 = String(pdfBase64 || '').replace(/^data:[^;]+;base64,/, '');

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
