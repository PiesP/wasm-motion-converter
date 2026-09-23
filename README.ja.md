# dropconvert

[English](./README.md) | [한국어](./README.ko.md)

ローカル動画をアップロードせずに、アニメーション GIF または WebP に変換します。
dropconvert はブラウザ内だけで動作し、すべてのランタイムコードをアプリケーションに同梱しています。

[dropconvert を開く](https://wasm-motion-converter.pages.dev/)

## 使い方

1. デバイスから動画を選択します。ファイルはブラウザ内だけに保持されます。
2. GIF または WebP、品質プリセット、出力倍率を選びます。ブラウザが動画の長さを
   読み取れる場合は、短い範囲を選択することもできます。
3. 変換を開始し、結果をプレビューしてダウンロードします。変換中は進行状況と
   キャンセル操作を利用できます。

## ブラウザ要件

dropconvert には WebCodecs（`VideoDecoder` と `VideoFrame`）および WebAssembly が必要です。
入力コーデックの対応状況はブラウザと OS によって異なります。アプリケーションは選択した
ファイルを確認し、未対応の構成を通知します。

Cross-Origin-Opener-Policy（COOP）と Cross-Origin-Embedder-Policy（COEP）ヘッダーは
セキュリティ境界として有効にされ、`SharedArrayBuffer` を利用可能にします。現在の
シングルスレッド WASM エンコーダーは、`SharedArrayBuffer` もクロスオリジン分離も必要としません。

動画変換では CPU とメモリを多く使用することがあります。範囲を短くし、品質と出力倍率を
下げると処理量を減らせます。

## プライバシー

変換、プレビュー、出力生成はブラウザ内でローカルに行われます。アプリケーションは
サーバー処理のためにメディアをアップロードせず、CDN からランタイムコードを読み込みません。

## 開発

このプロジェクトは AI ツールの支援を受けて開発されています。セットアップと検証手順は
[Contributing](./CONTRIBUTING.md) に、テストプロファイルとフィクスチャは
[テストガイド](./test/README.md) に記載しています。

## サポート

- 使い方とトラブルシューティング：[Support](./SUPPORT.md)
- バグと機能リクエスト：[GitHub Issues](https://github.com/PiesP/wasm-motion-converter/issues)
- 脆弱性とプライバシーに関する報告：[セキュリティポリシー](./.github/SECURITY.md)

## ライセンス

MIT。[LICENSE](./LICENSE) と [サードパーティライセンス](./public/LICENSES.md) を参照してください。
