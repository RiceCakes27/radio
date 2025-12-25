const express = require('express');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const fs = require('fs');
const ffmpegPath = require('ffmpeg-static');
require('dotenv').config({ quiet: true });

const httpPort = process.env.httpPort || 80;  // HTTP port
const httpsPort = process.env.httpsPort || 443; // HTTPS port
const ip = process.env.ip || 'localhost';
const vlcStreamUrl = process.env.streamUrl || 'http://localhost:8080'; // Replace with your VLC stream URL

const sslOptions = {
  key: fs.readFileSync(process.env.key), // Set in env file
  cert: fs.readFileSync(process.env.cert), // Set in env file
};

const app = express();

// Create HTTP server
const httpServer = http.createServer((req, res) => {
  // Redirect HTTP traffic to HTTPS
  res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
  res.end();
});

// Create HTTPS server
const httpsServer = https.createServer(sslOptions, app);

const connectedIPs = new Map(); // To store connected IP addresses and last activity time
const activeStreams = new Set(); // Track active response streams

// Shared FFmpeg instance
let sharedFFmpeg = null;
let ffmpegBuffer = []; // Buffer to store recent FFmpeg output
const maxBufferSize = 10; // Keep last 10 chunks for new clients

// Function to print currently connected IPs
const printConnectedIPs = () => {
  console.clear(); // Clear the terminal
  console.log('Currently connected IPs:', Array.from(connectedIPs.keys()));
  console.log('Active streams:', activeStreams.size);
  console.log('FFmpeg running:', sharedFFmpeg !== null);
};

// Start shared FFmpeg instance
const startFFmpeg = () => {
  if (sharedFFmpeg) return; // Already running

  console.log('Starting shared FFmpeg instance...');
  
  sharedFFmpeg = spawn(ffmpegPath, [
    '-i', vlcStreamUrl,      // Input stream from VLC
    '-f', 'mp3',             // Output format
    '-ab', '128k',           // Audio bitrate
    '-vn',                   // No video
    'pipe:1'                 // Pipe the output to stdout
  ]);

  sharedFFmpeg.on('error', (err) => {
    console.error('Error starting ffmpeg:', err);
    sharedFFmpeg = null;
  });

  sharedFFmpeg.on('exit', (code) => {
    console.log(`FFmpeg exited with code ${code}`);
    sharedFFmpeg = null;
    ffmpegBuffer = [];
  });

  sharedFFmpeg.stdout.on('data', (chunk) => {
    // Add to buffer for new clients
    ffmpegBuffer.push(chunk);
    if (ffmpegBuffer.length > maxBufferSize) {
      ffmpegBuffer.shift(); // Remove oldest chunk
    }

    // Broadcast to all active streams
    activeStreams.forEach((stream) => {
      if (!stream.destroyed && !stream.closed) {
        stream.write(chunk);
      }
    });
  });

  sharedFFmpeg.stderr.on("data", (data) => {
    const msg = data.toString();
    if (msg.match(/error/i)) console.error("[FFMPEG]", msg);
  });
};

// Stop shared FFmpeg instance
const stopFFmpeg = () => {
  if (!sharedFFmpeg) return;

  console.log('Stopping shared FFmpeg instance...');
  sharedFFmpeg.kill('SIGINT');
  sharedFFmpeg = null;
  ffmpegBuffer = [];
};

// Periodically check for inactive connections
setInterval(() => {
  const now = Date.now();
  const timeout = 60000; // 60 seconds timeout for inactive connections

  for (const [ip, lastActivity] of connectedIPs.entries()) {
    if (now - lastActivity > timeout) {
      console.log(`Removing inactive IP: ${ip}`);
      connectedIPs.delete(ip);
    }
  }
  printConnectedIPs();
}, 30000); // Run every 30 seconds

app.set('trust proxy', true);

// Middleware to track connected IPs and their activity
app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;

  // Convert IPv6-mapped IPv4 to regular IPv4
  const normalizedIP = ip.startsWith('::ffff:') ? ip.substring(7) : ip;

  // Store normalized IP in the request object
  req.normalizedIP = normalizedIP;

  // Update the last activity time for the IP
  connectedIPs.set(normalizedIP, Date.now());
  printConnectedIPs();

  next();
});

// Endpoint to stream audio directly
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Connection', 'keep-alive'); // Keep the connection open

  console.log(`New client connected: ${req.normalizedIP}`);

  // Start FFmpeg if not already running
  if (!sharedFFmpeg) {
    startFFmpeg();
  }

  // Send buffered data to new client (helps with immediate playback)
  ffmpegBuffer.forEach((chunk) => {
    if (!res.destroyed && !res.closed) {
      res.write(chunk);
    }
  });

  // Add this response stream to active streams
  activeStreams.add(res);
  printConnectedIPs();

  // Update activity time periodically while connected
  const activityInterval = setInterval(() => {
    connectedIPs.set(req.normalizedIP, Date.now());
  }, 5000); // Update every 5 seconds

  // When the connection ends (due to client closing the stream)
  res.on('close', () => {
    console.log(`Client disconnected: ${req.normalizedIP}`);
    
    clearInterval(activityInterval);
    activeStreams.delete(res);
    connectedIPs.delete(req.normalizedIP);
    
    // Stop FFmpeg if no more active streams
    if (activeStreams.size === 0) {
      stopFFmpeg();
    }
    
    printConnectedIPs();
  });

  res.on('error', (err) => {
    console.error(`Stream error for ${req.normalizedIP}:`, err.message);
    clearInterval(activityInterval);
    activeStreams.delete(res);
  });
});

// Start the servers
httpServer.listen(httpPort, ip, () => {
  console.log(`HTTP server is running on http://${ip}:${httpPort}`);
});

httpsServer.listen(httpsPort, ip, () => {
  console.log(`HTTPS server is running on https://${ip}:${httpsPort}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  stopFFmpeg();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  stopFFmpeg();
  process.exit(0);
});