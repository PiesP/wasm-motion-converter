# Browser Compatibility

This document details browser support and feature availability for dropconvert-wasm.

---

## Browser Support Matrix

| Browser | Version | FFmpeg | WebCodecs | SharedArrayBuffer | Overall Support |
|---------|---------|--------|-----------|-------------------|-----------------|
| **Chrome** | 94+ | ✅ Full | ✅ Full | ✅ Yes | ⭐ Excellent |
| **Edge** | 94+ | ✅ Full | ✅ Full | ✅ Yes | ⭐ Excellent |
| **Chrome (Android)** | 94+ | ✅ Full | ✅ Full | ✅ Yes | ⭐ Excellent |
| **Safari** | 16.4+ | ✅ Full | ⚠️ Limited | ✅ Yes | ✔️ Good |
| **Safari (iOS)** | 16.4+ | ✅ Full | ⚠️ Limited | ✅ Yes | ✔️ Good |
| **Firefox** | 120+ | ✅ Full | ❌ No | ✅ Yes | ✔️ Good |
| **Samsung Internet** | 21+ | ✅ Full | ✅ Yes | ✅ Yes | ✔️ Good |
| **Opera** | 80+ | ✅ Full | ✅ Yes | ✅ Yes | ✔️ Good |

### Legend
- ✅ Full support
- ⚠️ Partial support (limited codecs or features)
- ❌ Not supported
- ⭐ Excellent (all features work optimally)
- ✔️ Good (works with automatic fallbacks)

---

## Feature Availability by Browser

### WebCodecs API Support

**Browsers with Full WebCodecs:**
- Chrome 94+ (Desktop & Android)
- Edge 94+
- Opera 80+
- Samsung Internet 21+

**Browsers with Partial WebCodecs:**
- Safari 16.4+ (macOS Ventura+, iOS 16.4+)
  - ⚠️ Limited codec support (primarily H.264)
  - ⚠️ Some WebCodecs features missing
  - ✅ Automatically falls back to FFmpeg when needed

**Browsers WITHOUT WebCodecs:**
- Firefox (any version as of January 2025)
  - ❌ WebCodecs not implemented
  - ✅ FFmpeg fallback works perfectly
  - ℹ️ WebCodecs support planned for future release

**Check WebCodecs Support:**
```javascript
const supported = typeof VideoDecoder !== 'undefined';
console.log('WebCodecs:', supported);
```

---

## Codec Support by Browser

### H.264 (AVC)

| Browser | FFmpeg | WebCodecs | Notes |
|---------|--------|-----------|-------|
| Chrome 94+ | ✅ | ✅ | Full support |
| Edge 94+ | ✅ | ✅ | Full support |
| Safari 16.4+ | ✅ | ✅ | Best codec for Safari |
| Firefox 120+ | ✅ | ❌ | FFmpeg only |

**Recommendation**: Best compatibility across all browsers

### VP9

| Browser | FFmpeg | WebCodecs | Notes |
|---------|--------|-----------|-------|
| Chrome 94+ | ✅ | ✅ | Full support |
| Edge 94+ | ✅ | ✅ | Full support |
| Safari 16.4+ | ✅ | ⚠️ | WebCodecs may fail, FFmpeg works |
| Firefox 120+ | ✅ | ❌ | FFmpeg only |

**Recommendation**: Good for Chrome/Edge, automatic fallback for Safari

### AV1

| Browser | FFmpeg | WebCodecs | Notes |
|---------|--------|-----------|-------|
| Chrome 94+ | ✅ | ✅ | Excellent WebCodecs support |
| Edge 94+ | ✅ | ✅ | Excellent WebCodecs support |
| Safari 16.4+ | ✅ | ❌ | FFmpeg fallback |
| Firefox 120+ | ✅ | ❌ | FFmpeg only |

**Recommendation**: Best quality-to-size ratio, use with Chrome/Edge for WebCodecs acceleration

### VP8

| Browser | FFmpeg | WebCodecs | Notes |
|---------|--------|-----------|-------|
| All Browsers | ✅ | ⚠️ | Mostly FFmpeg path |

**Recommendation**: Older codec, limited WebCodecs support

### HEVC (H.265)

| Browser | FFmpeg | WebCodecs | Notes |
|---------|--------|-----------|-------|
| All Browsers | ❌ | ❌ | **NOT SUPPORTED** |

**Recommendation**: Re-encode to H.264 before conversion

---

## SharedArrayBuffer Availability

Required for FFmpeg multithreading (4× faster conversion).

### Desktop Browsers

| Browser | Support | Requirements |
|---------|---------|--------------|
| Chrome 92+ | ✅ Yes | COOP + COEP headers |
| Edge 92+ | ✅ Yes | COOP + COEP headers |
| Safari 15.2+ | ✅ Yes | COOP + COEP headers |
| Firefox 79+ | ✅ Yes | COOP + COEP headers |

**Note**: All browsers require **cross-origin isolation** (COOP/COEP headers).

### Mobile Browsers

| Browser | Support | Notes |
|---------|---------|-------|
| Chrome (Android) 92+ | ✅ Yes | Full support with headers |
| Safari (iOS) 15.2+ | ✅ Yes | Full support with headers |
| Firefox (Android) 79+ | ✅ Yes | Full support with headers |
| Samsung Internet 16+ | ✅ Yes | Full support with headers |

**Important**: Mobile browsers may have stricter memory limits.

### Private/Incognito Mode

| Browser | SharedArrayBuffer in Private Mode |
|---------|-----------------------------------|
| Chrome | ❌ Disabled by default |
| Edge | ❌ Disabled by default |
| Safari | ❌ Disabled |
| Firefox | ❌ Disabled |

**Workaround**: Use regular browsing mode for best performance.

---

## Output Format Support

### GIF

| Browser | FFmpeg | WebCodecs Path | Notes |
|---------|--------|----------------|-------|
| All | ✅ Full | ✅ Yes (via modern-gif) | Universal support |

**Best Browser**: Any browser (universal)

### WebP (Animated)

| Browser | FFmpeg | WebCodecs Path | Display Support |
|---------|--------|----------------|-----------------|
| Chrome 94+ | ✅ | ✅ | ✅ Full |
| Edge 94+ | ✅ | ✅ | ✅ Full |
| Safari 16+ | ✅ | ✅ | ✅ Full |
| Firefox 65+ | ✅ | ❌ | ✅ Full |

**Best Browser**: Chrome/Edge for GPU-accelerated encoding

---

## Performance Comparison

### Conversion Speed (30-second 1080p H.264 video to GIF)

| Browser | Path | SharedArrayBuffer | Approx. Time |
|---------|------|-------------------|--------------|
| Chrome 94+ | WebCodecs | ✅ Yes | ~15-20s ⚡ |
| Chrome 94+ | FFmpeg | ✅ Yes (4 threads) | ~30-40s |
| Chrome 94+ | FFmpeg | ❌ No (1 thread) | ~90-120s |
| Safari 16.4+ | FFmpeg | ✅ Yes (4 threads) | ~35-45s |
| Firefox 120+ | FFmpeg | ✅ Yes (4 threads) | ~30-40s |

**Key Takeaways:**
- WebCodecs path is ~2× faster than FFmpeg (Chrome/Edge)
- SharedArrayBuffer gives ~3× speedup (multithreading)
- Without SharedArrayBuffer, conversions are significantly slower

---

## Mobile Browser Specific Notes

### Chrome (Android)

- ✅ Full WebCodecs support
- ✅ SharedArrayBuffer with COOP/COEP
- ⚠️ Memory limits stricter than desktop
- 💡 **Recommendation**: Best mobile browser for this app

### Safari (iOS)

- ⚠️ Limited WebCodecs (H.264 works best)
- ✅ SharedArrayBuffer with headers
- ⚠️ Strict memory management
- 💡 **Recommendation**: Use H.264 videos, keep under 30 seconds

### Firefox (Android)

- ❌ No WebCodecs (FFmpeg fallback)
- ✅ SharedArrayBuffer with headers
- ⚠️ Slower than Chrome on mobile
- 💡 **Recommendation**: Works but prefer Chrome if available

### Samsung Internet

- ✅ Based on Chromium (similar to Chrome)
- ✅ WebCodecs support
- ✅ Good performance
- 💡 **Recommendation**: Excellent alternative to Chrome

---

## Known Browser Limitations

### Safari Limitations

1. **WebCodecs codec support** is limited to:
   - H.264 (primary support)
   - HEVC on compatible devices
   - VP9/AV1 support varies by version

2. **Memory management** is strict:
   - May fail with large files sooner than Chrome
   - Aggressive garbage collection

3. **Video format support**:
   - Prefers MP4 container
   - WebM support varies by version

**Workaround**: App automatically uses FFmpeg fallback

### Firefox Limitations

1. **No WebCodecs API** (as of January 2025)
   - All conversions use FFmpeg path
   - Still works well with SharedArrayBuffer multithreading

2. **Tracking protection** may affect:
   - CDN access for FFmpeg
   - Resource loading

**Workaround**: Disable tracking protection for site if needed

### Mobile Safari Limitations

1. **Memory limits** stricter than desktop Safari
2. **Background tabs** may be suspended
3. **Battery saver mode** affects performance

**Recommendations:**
- Keep app in foreground during conversion
- Disable battery saver mode
- Use shorter videos (<30 seconds)

---

## Progressive Web App (PWA) Support

| Browser | Add to Home Screen | Offline Capable | Notes |
|---------|-------------------|-----------------|-------|
| Chrome (Android) | ✅ | ⚠️ Partial | FFmpeg needs online |
| Safari (iOS) | ✅ | ⚠️ Partial | FFmpeg needs online |
| Edge | ✅ | ⚠️ Partial | Works if FFmpeg cached |

**Note**: FFmpeg core files (~30MB) are downloaded from CDN, requiring internet on first use. After caching (15-minute window), can work briefly offline.

---

## Accessibility Support

| Browser | Screen Reader | Keyboard Navigation |
|---------|--------------|---------------------|
| Chrome | ✅ NVDA/JAWS | ✅ Full |
| Edge | ✅ Narrator/NVDA | ✅ Full |
| Safari | ✅ VoiceOver | ✅ Full |
| Firefox | ✅ NVDA/JAWS | ✅ Full |

All browsers fully support ARIA attributes and keyboard navigation.

---

## Testing Recommendations

### For Best Experience

1. **Desktop**: Chrome 94+ or Edge 94+
2. **Mobile**: Chrome (Android) or Safari (iOS) latest version
3. **Ensure**: HTTPS with COOP/COEP headers
4. **Use**: Regular browsing mode (not private/incognito)

### For Compatibility Testing

Test on:
- ✅ Chrome (latest - 2 versions)
- ✅ Safari (latest)
- ✅ Firefox (latest)
- ✅ Edge (latest)
- ✅ Chrome Mobile (Android)
- ✅ Safari Mobile (iOS)

---

## Browser Update Recommendations

### Minimum Versions

- Chrome/Edge: 92+ (for SharedArrayBuffer)
- Safari: 15.2+ (for SharedArrayBuffer)
- Firefox: 79+ (for SharedArrayBuffer)

### Recommended Versions

- Chrome/Edge: 94+ (for WebCodecs)
- Safari: 16.4+ (for WebCodecs partial support)
- Firefox: 120+ (latest stable)

### Browser Detection

The app automatically detects browser capabilities and selects optimal conversion path:

```javascript
// Checked automatically on app load
const capabilities = {
  webcodecs: typeof VideoDecoder !== 'undefined',
  sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  crossOriginIsolated: crossOriginIsolated
};
```

---

## Future Browser Support

### Upcoming Features

**WebCodecs in Firefox:**
- Status: Under development
- Expected: 2025
- Impact: Will enable GPU-accelerated conversions in Firefox

**AV2 Codec:**
- Status: Emerging standard
- Browser support: TBD
- Impact: Better compression than AV1

**Improved Safari WebCodecs:**
- Status: Ongoing improvements
- Expected: Future Safari versions
- Impact: Better codec support parity with Chrome

---

## Polyfills & Fallbacks

The app includes automatic fallbacks:

1. **WebCodecs not available** → FFmpeg path
2. **SharedArrayBuffer unavailable** → Single-threaded FFmpeg
3. **Specific codec unsupported** → FFmpeg conversion
4. **WebCodecs decode fails** → Automatic FFmpeg fallback

**No polyfills required** - app handles all compatibility internally.

---

## Platform-Specific Notes

### Windows

- Chrome/Edge: Excellent performance
- Firefox: Good (FFmpeg only)
- All modern features supported

### macOS

- Chrome/Edge: Excellent performance
- Safari: Good (limited WebCodecs)
- Best native browser: Chrome

### Linux

- Chrome/Chromium: Excellent
- Firefox: Good (FFmpeg only)
- Edge (Linux): Excellent

### Android

- Chrome: Excellent (best mobile browser for app)
- Samsung Internet: Excellent
- Firefox: Good (FFmpeg only)

### iOS

- Safari: Good (only browser engine allowed)
- Chrome iOS: Same as Safari (uses WebKit)
- Firefox iOS: Same as Safari (uses WebKit)

**Note**: All iOS browsers use Safari's WebKit engine due to iOS restrictions.

---

## Debugging Browser Issues

### Check Browser Capabilities

Paste in console:
```javascript
console.table({
  'WebCodecs': typeof VideoDecoder !== 'undefined',
  'SharedArrayBuffer': typeof SharedArrayBuffer !== 'undefined',
  'crossOriginIsolated': crossOriginIsolated,
  'Browser': navigator.userAgent.split(' ').slice(-2).join(' ')
});
```

### Test Conversion Paths

```javascript
// Force FFmpeg (for testing)
localStorage.setItem('forceFFmpegPath', 'true');

// Force WebCodecs (will fail if unsupported)
localStorage.setItem('forceWebCodecsPath', 'true');

// Reset to auto
localStorage.clear();
```

---

## Reporting Browser-Specific Issues

When reporting a browser bug, include:

```javascript
// Run in console and include output
console.log(JSON.stringify({
  userAgent: navigator.userAgent,
  webcodecs: typeof VideoDecoder !== 'undefined',
  sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  crossOriginIsolated: crossOriginIsolated,
  memory: navigator.deviceMemory,
  hardwareConcurrency: navigator.hardwareConcurrency
}, null, 2));
```

---

## Recommendations Summary

### Best Overall: Chrome/Edge Desktop
- Full WebCodecs support
- SharedArrayBuffer
- Fastest conversions
- All codecs supported

### Best Mobile: Chrome (Android)
- Full WebCodecs support
- Best performance on mobile
- All features work

### Best iOS: Safari (latest)
- Only real option on iOS
- Works well with H.264
- Automatic FFmpeg fallback

### Best for Privacy: Firefox
- No WebCodecs (slower)
- Good tracking protection
- Reliable FFmpeg support

---

For troubleshooting browser issues, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).
