# SignSpeak 🤟

**SignSpeak** is a web application that reads sign language directly from your webcam in real-time and displays live subtitles at the bottom of the screen, just like closed captions on a video call.

## Step 1 Features
- 🎥 **Live Fullscreen-Framed Webcam**: Smooth webcam capture directly inside your browser.
- 🤖 **MediaPipe Hand Landmarker**: Runs directly in the browser using WebAssembly and GPU acceleration (no backend required).
- 🖐️ **21 Hand Landmark Visualizer**: Real-time rendering of all 21 hand joints, connecting bones, and highlighted fingertips.
- 💬 **Cinematic Movie Subtitles**: Dark frosted glass subtitle overlay positioned at the bottom center.
- ⚡ **Modern Dark UI**: Built with Vite, React, and Tailwind CSS.

## Getting Started

### 1. Prerequisites
You need **Node.js** (version 18 or newer) installed on your computer.
If you don't have it yet, download it for free from [nodejs.org](https://nodejs.org/) (choose the **LTS** version).

### 2. Install Dependencies
Open your terminal (or Command Prompt / PowerShell) in this folder and run:
```bash
npm install
```

### 3. Run Development Server
```bash
npm run dev
```

### 4. Open in Browser
Click on or visit the local URL shown in your terminal (typically `http://localhost:5173`).
Allow camera permissions when prompted by your browser, and bring your hand into the camera frame!
