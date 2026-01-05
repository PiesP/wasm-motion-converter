# Troubleshooting Guide

This guide covers common issues and their solutions for dropconvert-wasm.

---

## SharedArrayBuffer Issues

### Problem: `crossOriginIsolated` is `false`

**Symptoms:**
- Warning banner: "SharedArrayBuffer unavailable"
- FFmpeg runs slowly (single-threaded mode)
- Console shows: `crossOriginIsolated: false`

**Root Cause:**
Missing cross-origin isolation headers (COOP/COEP)

**Solutions:**

#### Development (Local)
Ensure `vite.config.ts` includes:
```typescript
export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
});
```

Then restart dev server:
```bash
pnpm dev
```

#### Production
1. **Check headers** using browser DevTools Network tab or curl:
   ```bash
   curl -I https://your-site.com
   ```

2. **Add headers** - See [DEPLOYMENT.md](./DEPLOYMENT.md) for platform-specific instructions

3. **Verify `public/_headers`** file exists and contains:
   ```
   /*
     Cross-Origin-Embedder-Policy: require-corp
     Cross-Origin-Opener-Policy: same-origin
   ```

4. **Clear cache** and hard reload (Ctrl+Shift+R / Cmd+Shift+R)

### Problem: SharedArrayBuffer Blocked by Browser

**Symptoms:**
- `typeof SharedArrayBuffer === 'undefined'`
- Even with correct headers

**Causes:**
- Firefox private browsing mode (SharedArrayBuffer disabled)
- Browser version too old
- Browser security settings

**Solutions:**
1. Use regular browsing mode (not private/incognito)
2. Update browser to latest version
3. Try different browser (Chrome, Edge, Safari)

---

## FFmpeg Loading Issues

### Problem: "Loading FFmpeg" Stuck at 0%

**Symptoms:**
- Progress bar doesn't move
- No network activity
- Console errors about CDN access

**Solutions:**

1. **Check Network Tab** in DevTools for errors

2. **Verify CDN Access**:
   - FFmpeg loads from `unpkg.com`
   - Check if CDN is blocked by firewall/VPN
   - Try disabling ad blockers

3. **Check CORS**:
   - CDN resources must be accessible
   - No CORS errors in console

4. **Retry Initialization**:
   ```javascript
   // Refresh page or manually trigger
   await ffmpegService.initialize();
   ```

### Problem: FFmpeg Download Timeout

**Symptoms:**
- "Failed to load FFmpeg" after ~2 minutes
- Network errors in console

**Solutions:**

1. **Slow Connection**: Core files are ~30MB
   - Wait longer on slow connections
   - Check download speed

2. **CDN Issues**:
   - Try different network
   - Check unpkg.com status

3. **Increase Timeout** (advanced):
   - Edit `src/utils/ffmpeg-constants.ts`
   - Increase `TIMEOUT.INITIALIZATION`

---

## Conversion Errors

### Problem: "Unsupported Format" Error

**Symptoms:**
- Error after file selection
- Message: "Codec not supported"

**Cause:**
Video codec not supported (e.g., HEVC/H.265, ProRes)

**Supported Codecs:**
- H.264 (AVC)
- VP9
- AV1
- VP8

**Solutions:**

1. **Re-encode Video**:
   ```bash
   # Convert to H.264 using FFmpeg (desktop)
   ffmpeg -i input.mov -c:v libx264 -preset fast output.mp4
   ```

2. **Try Different Video**: Use a video with supported codec

3. **Check Codec**: Use MediaInfo or FFmpeg to identify codec:
   ```bash
   ffmpeg -i video.mp4
   ```

### Problem: Conversion Timeout

**Symptoms:**
- Progress stuck at specific percentage
- Error after 5 minutes: "Conversion timeout"

**Causes:**
- Very large file (>500MB)
- High resolution (4K+)
- Complex codec

**Solutions:**

1. **Reduce File Size**:
   - Use lower scale setting (0.5× or 0.75×)
   - Trim video to shorter duration

2. **Lower Quality**:
   - Select "Low" or "Medium" quality
   - Reduces processing time

3. **Check Memory**:
   - Close other tabs
   - Conversion may fail on low-memory devices

### Problem: "Out of Memory" Error

**Symptoms:**
- Conversion fails partway through
- Browser tab crashes
- Error: "Memory critical"

**Solutions:**

1. **Reduce Video Size**:
   - Scale: Use 0.5× or 0.75×
   - Trim video to <30 seconds
   - Lower resolution source

2. **Close Other Tabs/Apps**:
   - Free up system memory
   - Close unused browser tabs

3. **Use Desktop Browser**:
   - Mobile browsers have stricter memory limits
   - Desktop has more available memory

4. **Try FFmpeg Path**:
   - App automatically tries FFmpeg fallback for high-memory conversions
   - GIF format uses less memory than WebP

---

## WebCodecs Issues

### Problem: WebCodecs Path Fails, Falls Back to FFmpeg

**Symptoms:**
- Progress shows "Decoding" then restarts
- Console log: "Falling back to FFmpeg"

**Cause:**
WebCodecs decode failure (browser limitation or codec issue)

**This is Expected Behavior:**
- App automatically falls back to FFmpeg
- No user action required
- Fallback ensures conversion still succeeds

**To Force FFmpeg Path:**
Set in browser console (for testing):
```javascript
localStorage.setItem('forceFFmpegPath', 'true');
```

### Problem: WebCodecs Not Available

**Symptoms:**
- All conversions use FFmpeg path
- No "GPU-accelerated" indicator

**Causes:**
- Browser doesn't support WebCodecs API
- Codec not supported by WebCodecs

**Check Support:**
```javascript
console.log('VideoDecoder:', typeof VideoDecoder);
// Should output: "function"
```

**Browsers with WebCodecs:**
- Chrome 94+
- Edge 94+
- Safari 16.4+ (limited codec support)
- Firefox: Not yet supported

**Solutions:**
- Update to latest browser version
- Use Chrome/Edge for best WebCodecs support
- FFmpeg fallback works on all browsers

---

## Performance Issues

### Problem: Slow Conversion (>2 minutes for short video)

**Causes:**
- Single-threaded FFmpeg (no SharedArrayBuffer)
- Large file size
- High resolution
- Slow device

**Solutions:**

1. **Enable Multithreading**:
   - Fix SharedArrayBuffer issues (see above)
   - Check `crossOriginIsolated === true`

2. **Optimize Settings**:
   - Scale: 0.5× or 0.75×
   - Quality: Low or Medium
   - Shorter video duration

3. **Use WebCodecs Path**:
   - Supported browsers: Chrome, Edge
   - AV1/VP9 codec for best performance
   - WebP output format

### Problem: UI Freezes During Conversion

**Symptoms:**
- Browser tab unresponsive
- Can't click buttons
- Progress bar stuck

**Solutions:**

1. **Wait**: Conversion runs in Web Worker, but large operations may block briefly

2. **Reduce Memory Usage**:
   - Close other tabs
   - Lower quality/scale settings

3. **Check Console**: Look for JavaScript errors

---

## UI/Display Issues

### Problem: Dark Mode Not Working

**Symptoms:**
- Theme toggle doesn't switch
- Stuck in light/dark mode

**Solutions:**

1. **Clear LocalStorage**:
   ```javascript
   localStorage.clear();
   location.reload();
   ```

2. **Check System Theme**:
   - If set to "System", matches OS preference
   - Override with manual light/dark selection

### Problem: File Dropzone Not Accepting Files

**Symptoms:**
- Can't drag/drop files
- No file picker dialog

**Solutions:**

1. **Check File Type**:
   - Must be video/* MIME type
   - Supported: .mp4, .webm, .mov

2. **Check File Size**:
   - Max size: 500MB
   - Larger files rejected with error

3. **Browser Permissions**:
   - Check if file access blocked
   - Try different browser

### Problem: Download Button Not Working

**Symptoms:**
- Clicking download does nothing
- No file downloaded

**Solutions:**

1. **Check Browser Permissions**:
   - Allow downloads from site
   - Check popup blocker settings

2. **Try Right-Click Save**:
   - Right-click download button
   - "Save link as..."

3. **Check Console**: Look for errors

---

## Mobile-Specific Issues

### Problem: Conversion Fails on Mobile

**Causes:**
- Limited memory on mobile devices
- SharedArrayBuffer support varies
- Battery saver mode

**Solutions:**

1. **Use Smaller Videos**:
   - <10 seconds duration
   - Lower resolution
   - Scale 0.5×

2. **Disable Battery Saver**:
   - Battery saver limits performance
   - Turn off during conversion

3. **Use Desktop**:
   - Desktop browsers have better support
   - More memory available

### Problem: Mobile Safari Issues

**Symptoms:**
- WebCodecs not available
- Slower conversions

**Expected:**
- Safari has limited WebCodecs support
- App uses FFmpeg fallback automatically

**Solutions:**
- Use Chrome on iOS for WebCodecs support (iOS 16.4+)
- Or accept slower FFmpeg conversion

---

## Error Messages

### "Network error downloading FFmpeg"

**Solution**:
- Check internet connection
- Verify unpkg.com is accessible
- Retry after connection restored

### "File format not supported"

**Solution**:
- Check video codec (must be H.264, VP9, or AV1)
- Re-encode video to supported codec
- Try different video file

### "Memory critical - conversion may fail"

**Solution**:
- Close other tabs/applications
- Use lower scale setting
- Use shorter video

### "Conversion timeout"

**Solution**:
- Reduce video length
- Lower quality/scale settings
- Try again with better internet connection

---

## Browser-Specific Issues

### Chrome/Edge

**Problem**: Extensions blocking conversion

**Solution**:
- Disable ad blockers
- Disable privacy extensions temporarily
- Try incognito mode (but note: SharedArrayBuffer may be disabled)

### Firefox

**Problem**: WebCodecs not supported

**Expected**: Firefox doesn't support WebCodecs yet (as of 2024)

**Solution**: FFmpeg fallback works automatically

### Safari

**Problem**: Limited codec support

**Solution**:
- Use H.264 videos
- WebCodecs support limited to specific codecs
- FFmpeg fallback available

---

## Debugging Tips

### Enable Verbose Logging

```javascript
localStorage.setItem('debug', 'true');
location.reload();
```

Check browser console for detailed logs.

### Check Environment

```javascript
console.log({
  crossOriginIsolated,
  SharedArrayBuffer: typeof SharedArrayBuffer,
  VideoDecoder: typeof VideoDecoder,
  userAgent: navigator.userAgent
});
```

### Test FFmpeg Directly

```javascript
import { ffmpegService } from './services/ffmpeg-service';

await ffmpegService.initialize();
const metadata = await ffmpegService.getVideoMetadata(file);
console.log(metadata);
```

### Clear All State

```javascript
localStorage.clear();
sessionStorage.clear();
location.reload();
```

---

## Getting Help

### Before Reporting an Issue

1. Check this troubleshooting guide
2. Check browser console for errors
3. Verify crossOriginIsolated status
4. Test with different video file
5. Try different browser

### Reporting Bugs

Include in bug report:
- Browser + version
- OS + device type
- Video details (format, codec, size)
- Console output
- Steps to reproduce

Check console for environment info:
```javascript
console.log({
  crossOriginIsolated,
  SharedArrayBuffer: typeof SharedArrayBuffer,
  VideoDecoder: typeof VideoDecoder,
  memory: performance.memory,
  userAgent: navigator.userAgent
});
```

---

## Known Limitations

1. **File Size**: Max 500MB (browser memory limitations)
2. **Duration**: Best results with videos <60 seconds
3. **Resolution**: 4K+ may fail on low-memory devices
4. **Codecs**: HEVC/H.265 not supported
5. **Mobile**: Limited by device memory and battery
6. **Safari**: Limited WebCodecs support

---

## Advanced Troubleshooting

### Force Specific Conversion Path

```javascript
// Force FFmpeg path (skip WebCodecs)
localStorage.setItem('forceFFmpegPath', 'true');

// Force WebCodecs path (may fail if unsupported)
localStorage.setItem('forceWebCodecsPath', 'true');

// Reset to automatic
localStorage.removeItem('forceFFmpegPath');
localStorage.removeItem('forceWebCodecsPath');
```

### Adjust Timeouts

Edit `src/utils/ffmpeg-constants.ts`:
```typescript
export const FFMPEG_INTERNALS = {
  TIMEOUT: {
    INITIALIZATION: 120000,  // Increase if needed
    METADATA: 30000,
    CONVERSION: 300000       // Increase for large files
  }
};
```

### Custom FFmpeg CDN

Edit `src/services/ffmpeg-service.ts` to use custom CDN URL.

---

For deployment-related issues, see [DEPLOYMENT.md](./DEPLOYMENT.md).

For browser compatibility details, see [BROWSER_COMPATIBILITY.md](./BROWSER_COMPATIBILITY.md).
