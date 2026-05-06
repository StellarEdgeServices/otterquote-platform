// Video Upload Handler for Dashboard
// Phase 1: Homeowner uploads video during intake; contractors see it in Phase 2 (D-211 gated)

class VideoUploadManager {
  constructor(claimId, userId) {
    this.claimId = claimId;
    this.userId = userId;
    this.isUploading = false;
    this.videoFile = null;
    this.maxDuration = 60; // seconds
    this.maxFileSize = 250 * 1024 * 1024; // 250MB
  }

  async handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Validate file size
    if (file.size > this.maxFileSize) {
      this.showError(`File size exceeds 250MB limit. Selected: ${(file.size / 1024 / 1024).toFixed(1)}MB`);
      return;
    }

    // Validate file type
    const validTypes = ['video/mp4', 'video/quicktime', 'video/webm'];
    if (!validTypes.includes(file.type)) {
      this.showError(`Invalid video format. Supported: MP4, MOV, WebM`);
      return;
    }

    // Load and validate video metadata
    const videoUrl = URL.createObjectURL(file);
    const videoElement = document.getElementById('previewVideo');
    
    if (!videoElement) {
      this.showError('Preview video element not found');
      return;
    }

    videoElement.src = videoUrl;
    
    videoElement.onloadedmetadata = () => {
      const duration = videoElement.duration;
      
      // Validate duration
      if (duration > this.maxDuration) {
        this.showError(`Video duration exceeds ${this.maxDuration} second limit. Actual: ${Math.round(duration)}s`);
        videoElement.src = '';
        this.clearVideo();
        return;
      }

      this.videoFile = file;
      this.showPreview(videoUrl, duration);
      this.uploadVideo(file);
    };

    videoElement.onerror = () => {
      this.showError('Failed to load video. Please check the file format.');
      this.clearVideo();
    };
  }

  showPreview(videoUrl, duration) {
    const previewContainer = document.getElementById('videoPreview');
    const metadata = document.getElementById('videoMetadata');
    
    if (previewContainer && metadata) {
      previewContainer.style.display = 'block';
      metadata.textContent = `${this.videoFile.name} • ${Math.round(duration)}s • ${(this.videoFile.size / 1024 / 1024).toFixed(1)}MB`;
    }
  }

  async uploadVideo(file) {
    if (this.isUploading) return;
    
    this.isUploading = true;
    this.showUploadProgress();

    try {
      // Generate signed URL from Supabase
      const fileName = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}.${file.name.split('.').pop()}`;
      const filePath = `videos/${this.userId}/${fileName}`;

      // Call edge function to get signed URL
      const response = await fetch('/api/get-signed-video-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, bucket: 'claim-documents' })
      });

      if (!response.ok) throw new Error('Failed to get upload URL');
      
      const { signedUrl } = await response.json();

      // Upload file using signed URL
      await this.uploadToSignedUrl(signedUrl, file);

      // Save URL to claims table
      await this.saveVideoUrlToDatabase(filePath);

      this.showSuccess('Video uploaded successfully');
      this.disableUploadButton();
    } catch (error) {
      this.showError(`Upload failed: ${error.message}`);
      this.clearVideo();
    } finally {
      this.isUploading = false;
      this.hideUploadProgress();
    }
  }

  async uploadToSignedUrl(signedUrl, file) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const progressBar = document.getElementById('progressBar');

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && progressBar) {
          const percentComplete = (e.loaded / e.total) * 100;
          progressBar.style.width = percentComplete + '%';
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`Upload failed with status ${xhr.status}`));
        }
      });

      xhr.addEventListener('error', () => reject(new Error('Upload failed')));
      xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));

      xhr.open('PUT', signedUrl, true);
      xhr.setRequestHeader('Content-Type', file.type);
      xhr.send(file);
    });
  }

  async saveVideoUrlToDatabase(filePath) {
    // Call edge function to save video URL to claims table
    const response = await fetch('/api/save-claim-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claimId: this.claimId,
        videoUrl: filePath
      })
    });

    if (!response.ok) {
      throw new Error('Failed to save video URL to database');
    }
  }

  clearVideo() {
    this.videoFile = null;
    const videoInput = document.getElementById('homeownerVideo');
    const previewContainer = document.getElementById('videoPreview');
    const videoElement = document.getElementById('previewVideo');
    
    if (videoInput) videoInput.value = '';
    if (videoElement) videoElement.src = '';
    if (previewContainer) previewContainer.style.display = 'none';
  }

  showError(message) {
    const uploadStatus = document.getElementById('videoUploadStatus');
    const uploadMessage = document.getElementById('uploadMessage');
    
    if (uploadStatus && uploadMessage) {
      uploadStatus.style.display = 'block';
      uploadMessage.textContent = `Error: ${message}`;
      uploadMessage.style.color = '#d32f2f';
    }
  }

  showSuccess(message) {
    const uploadStatus = document.getElementById('videoUploadStatus');
    const uploadMessage = document.getElementById('uploadMessage');
    
    if (uploadStatus && uploadMessage) {
      uploadStatus.style.display = 'block';
      uploadMessage.textContent = message;
      uploadMessage.style.color = '#388e3c';
    }
  }

  showUploadProgress() {
    const uploadStatus = document.getElementById('videoUploadStatus');
    if (uploadStatus) uploadStatus.style.display = 'block';
  }

  hideUploadProgress() {
    // Keep progress visible for 2 seconds, then hide
    setTimeout(() => {
      const uploadStatus = document.getElementById('videoUploadStatus');
      if (uploadStatus) uploadStatus.style.display = 'none';
    }, 2000);
  }

  disableUploadButton() {
    const selectBtn = document.getElementById('selectVideoBtn');
    if (selectBtn) {
      selectBtn.disabled = true;
      selectBtn.textContent = 'Video uploaded';
    }
  }
}
