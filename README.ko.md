# dropconvert

[English](./README.md) | [日本語](./README.ja.md)

로컬 동영상을 업로드하지 않고 애니메이션 GIF 또는 WebP로 변환합니다.
dropconvert는 브라우저 안에서만 실행되며, 모든 런타임 코드를 애플리케이션에
포함합니다.

[dropconvert 열기](https://wasm-motion-converter.pages.dev/)

## 사용 방법

1. 기기에서 동영상을 선택합니다. 파일은 브라우저 안에만 머뭅니다.
2. GIF 또는 WebP, 품질 프리셋, 출력 배율을 선택합니다. 브라우저가 동영상
   길이를 읽을 수 있으면 더 짧은 구간도 선택할 수 있습니다.
3. 변환을 시작한 다음 결과를 미리 보고 다운로드합니다. 변환 중에는 진행 상황과
   취소 컨트롤을 사용할 수 있습니다.

## 브라우저 요구사항

dropconvert에는 WebCodecs(`VideoDecoder`와 `VideoFrame`)와 WebAssembly가
필요합니다. 입력 코덱 지원 여부는 브라우저와 운영체제에 따라 다릅니다.
애플리케이션은 선택한 파일을 검사하고 지원하지 않는 구성을 알려 줍니다.

Cross-Origin-Opener-Policy(COOP)와 Cross-Origin-Embedder-Policy(COEP) 헤더는
보안 경계로 계속 사용하며 `SharedArrayBuffer`를 사용할 수 있게 합니다. 현재의
단일 스레드 WASM 인코더에는 `SharedArrayBuffer`나 교차 출처 격리가 필요하지
않습니다.

동영상 변환에는 CPU와 메모리가 많이 사용될 수 있습니다. 구간을 짧게 하고,
품질과 출력 배율을 낮추면 작업량을 줄일 수 있습니다.

## 개인정보 보호

변환, 미리 보기, 결과 생성은 브라우저 안에서 로컬로 처리됩니다. 애플리케이션은
서버 처리를 위해 미디어를 업로드하지 않으며 CDN에서 런타임 코드를 불러오지
않습니다.

## 개발

이 프로젝트는 AI 도구의 도움을 받아 개발합니다. 설정과 검증 방법은
[기여 안내](./CONTRIBUTING.md)에, 테스트 프로필과 픽스처는
[테스트 안내](./test/README.md)에 설명되어 있습니다.

## 지원

- 사용 방법과 문제 해결: [지원](./SUPPORT.md)
- 버그 및 기능 요청: [GitHub Issues](https://github.com/PiesP/wasm-motion-converter/issues)
- 취약점 및 개인정보 보호 문제: [보안 정책](./.github/SECURITY.md)

## 라이선스

MIT. [LICENSE](./LICENSE)와 [서드파티 라이선스](./public/LICENSES.md)를 참고하세요.
