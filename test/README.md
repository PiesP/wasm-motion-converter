# wasm-motion-converter 테스트 관리 가이드

## 개요

wasm-motion-converter의 변환 테스트는 Playwright 기반 E2E 테스트입니다.
로컬 개발 서버(`pnpm dev`)에서 실행되며, 배포 페이지에 의존하지 않습니다.

## 디렉토리 구조

```
test/
├── lib/
│   ├── test-manifest.ts    ← 단일 진실 소스: 비디오 정의, 베이스라인 결과
│   ├── test-matrix.ts      ← 매트릭스 생성기: codec × format × quality 조합
│   └── test-recorder.ts    ← 결과 기록: JSONL + 회귀 감지 + 리포트
├── e2e/
│   ├── fixtures/
│   │   ├── test-helpers.ts  ← 공통 헬퍼 (__TEST_HELPERS__ 기반)
│   │   └── verify.ts        ← 출력 검증 (GIF/WebP 유효성)
│   ├── smoke.spec.ts        ← 스모크 테스트: 핵심 경로 빠른 검증
│   ├── matrix.spec.ts       ← 매트릭스 테스트: 전체 코덱×포맷 조합
│   ├── regression.spec.ts   ← 회귀 테스트: 베이스라인 비교
│   └── debug/               ← 디버그/벤치마크 (자동 실행 제외)
│       ├── debug-local.spec.ts
│       ├── debug-gif-logs.spec.ts
│       └── benchmark-local.spec.ts
├── playwright.config.ts      ← Playwright 설정 (로컬 서버 자동 시작)
└── tsconfig.playwright.json ← Playwright 전용 TS 설정
```

## 테스트 비디오 파일

`public/` 디렉토리에 7개 테스트 비디오가 있습니다:

| 파일 | 코덱 | 해상도 | 길이 | 크기 |
|------|------|--------|------|------|
| test-video-h264-baseline.mp4 | H.264 Baseline | 1920×1080 | 9.75s | 822 KB |
| test-video-h264-main.mp4 | H.264 Main | 1920×1080 | 9.75s | 656 KB |
| test-video-h264-high.mp4 | H.264 High | 1920×1080 | 9.75s | 660 KB |
| test-video-hevc.mp4 | HEVC Main | 1920×1080 | 9.75s | 496 KB |
| test-video-vp8.webm | VP8 | 1920×1080 | 9.75s | 3.7 MB |
| test-video-vp9.webm | VP9 Profile 0 | 1920×1080 | 9.75s | 1.5 MB |
| test-video-av1.webm | AV1 Main | 1920×1080 | 9.75s | 1.5 MB |

## 실행 명령어

### 전체 테스트 실행 (스모크 + 매트릭스 + 회귀)
```bash
cd test
pnpm test
```

### 스모크 테스트만 (빠른 검증)
```bash
cd test
pnpm test -- smoke.spec.ts
```

### 매트릭스 테스트만 (전체 코덱×포맷)
```bash
cd test
pnpm test -- matrix.spec.ts
```

### 회귀 테스트 (매트릭스 실행 후)
```bash
cd test
pnpm test -- regression.spec.ts
```

### 디버그/벤치마크 (수동 실행)
```bash
cd test
pnpm test -- debug/debug-local.spec.ts
pnpm test -- debug/benchmark-local.spec.ts
```

## 테스트 계층

| 계층 | 파일 | 목적 | 실행 시간 |
|------|------|------|-----------|
| **Smoke** | `smoke.spec.ts` | 핵심 경로 빠른 검증 | ~5분 |
| **Matrix** | `matrix.spec.ts` | 전체 코덱×포맷 조합 | ~30분 |
| **Regression** | `regression.spec.ts` | 베이스라인 비교 | ~1분 |
| **Debug** | `debug/*` | 문제 진단 (수동) | 상황별 |

## 매니페스트 수정

새 비디오를 추가하려면 `test/lib/test-manifest.ts`의 `TEST_VIDEOS` 배열에 엔트리를 추가합니다:

```typescript
{
  id: 'my-new-video',
  file: '/test-video-my-new.mp4',
  label: 'My New Video',
  codec: 'h264-main',
  width: 1920,
  height: 1080,
  duration: 10,
  frameRate: 30,
  fileSizeBytes: 1000000,
  webCodecsSupported: true,  // FFmpeg direct path 사용 여부
  testTrimSeconds: 5,
  maxConversionTimeMs: 60_000,
}
```

베이스라인 결과도 `BASELINE_RESULTS`와 `BASELINE_TIMINGS`에 추가합니다.

## 회귀 감지

`test/.results/conversion-results.jsonl`에 모든 변환 결과가 기록됩니다.
- 출력 크기가 베이스라인의 1.5배를 초과하면 크기 회귀
- 변환 시간이 베이스라인의 2배를 초과하면 시간 회귀
- 이전 성공 케이스가 실패하면 실패 회귀

## 주의사항

- `test/`는 별도 git 레포지토리입니다 (`git init`으로 초기화됨)
- 메인 레포의 `.gitignore`에 `test/`가 포함되어 있습니다
- 테스트는 로컬 개발 서버(`http://127.0.0.1:5173`)에서 실행됩니다
- Playwright가 자동으로 개발 서버를 시작합니다 (`webServer` 설정)
- Headless Chrome에서 SharedArrayBuffer를 위해 `--enable-features=SharedArrayBuffer` 플래그 사용
