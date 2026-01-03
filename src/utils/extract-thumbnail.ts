/**
 * Extracts the first frame from a video file as a thumbnail
 * @param file - The video file to extract thumbnail from
 * @returns A promise that resolves to the thumbnail image as a data URL, or null if extraction fails
 */
export async function extractVideoThumbnail(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      resolve(null);
      return;
    }

    const url = URL.createObjectURL(file);
    video.src = url;

    // Load the first frame
    const handleLoadedMetadata = () => {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      // Draw the first frame onto the canvas
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      // Clean up
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('error', handleError);
      URL.revokeObjectURL(url);

      // Return the canvas as a data URL
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      resolve(dataUrl);
    };

    const handleError = () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('error', handleError);
      URL.revokeObjectURL(url);
      resolve(null);
    };

    video.addEventListener('loadedmetadata', handleLoadedMetadata, { once: true });
    video.addEventListener('error', handleError, { once: true });

    // Start loading
    video.load();
  });
}
