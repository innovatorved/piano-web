# Web Air Piano - Setup Guide

This guide will help you set up and deploy the Web Air Piano project, which allows users to play chords using hand gestures in the browser.

## Prerequisites

- Node.js (v16 or newer)
- npm or yarn
- A modern web browser (Chrome recommended)
- A webcam

## Step 6: Run the development server

```bash
npm run dev
```

Visit `http://localhost:5173` in your browser to see the application running.

## Step 7: Allow camera access

When prompted, allow the application to access your webcam.

## How to Use

1. Position yourself in front of the webcam
2. Raise different fingers to play different chords:
   - Thumb: D Major
   - Index: E Minor
   - Middle: F# Minor
   - Ring: G Major
   - Pinky: A Major
3. Move your hand higher or lower to change the pitch
4. Lower your fingers to stop playing the chord

## Deployment Options

### Deploying to Netlify

1. Create a `netlify.toml` file in the root directory:

```toml
[build]
  command = "npm run build"
  publish = "dist"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

2. Push your code to GitHub
3. Connect your GitHub repository to Netlify
4. Click "Deploy site"

### Deploying to Vercel

1. Install the Vercel CLI:

```bash
npm install -g vercel
```

2. Run the deployment command:

```bash
vercel
```

3. Follow the prompts to complete deployment

## Notes

- The application requires camera permissions and works best in Chrome
- Users need to allow camera access to use the application
- For optimal performance, ensure good lighting conditions
- The hand detection model may take a few seconds to load on first visit

## Troubleshooting

- If the camera doesn't activate, check browser permissions
- If hand detection is unstable, try improving lighting conditions
- If chords don't play, check that audio is not muted in the browser
