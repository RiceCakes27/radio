const express = require('express');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const fs = require('fs');
const ffmpegPath = require('ffmpeg-static');
require('dotenv').config();

const app = express();
const httpPort = 80;  // HTTP port
const httpsPort = 443; // HTTPS port

const sslOptions = {
  key: fs.readFileSync(process.env.key), // Set in env file
  cert: fs.readFileSync(process.env.cert), // Set in env file
};

// VLC stream URL
const vlcStreamUrl = 'http://localhost:8080'; // Replace with your VLC stream URL
const connectedIPs = new Map(); // To store connected IP addresses and last activity time

// Function to print currently connected IPs
const printConnectedIPs = () => {
  console.clear(); // Clear the terminal
  console.log('Currently connected IPs:', Array.from(connectedIPs.keys()));
};

// Create HTTPS server
const httpsServer = https.createServer(sslOptions, app);

// Create HTTP server
const httpServer = http.createServer((req, res) => {
  // Redirect HTTP traffic to HTTPS
  res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
  res.end();
});

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

  // We don't immediately remove the IP here to avoid premature deletion.
  next();
});

// Endpoint to stream audio directly
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Connection', 'keep-alive'); // Keep the connection open

  console.log('Starting stream...');

  const ffmpeg = spawn(ffmpegPath, [
    '-i', vlcStreamUrl,      // Input stream from VLC
    '-f', 'mp3',             // Output format
    '-ab', '128k',           // Audio bitrate
    '-vn',                   // No video
    'pipe:1'                 // Pipe the output to stdout
  ]);

  ffmpeg.on('error', (err) => {
    console.error('Error starting ffmpeg:', err);
    res.status(500).send('Error starting audio stream.');
  });

  // Update last activity time whenever data is sent
  ffmpeg.stdout.on('data', () => {
    connectedIPs.set(req.normalizedIP, Date.now()); // Update activity time
  });

  ffmpeg.stdout.pipe(res);

  // When the connection ends (due to client closing the stream)
  res.on('close', () => {
    console.log('Client disconnected, stopping stream...');
    ffmpeg.kill('SIGINT'); // Stop ffmpeg when client disconnects

    // Delay removal of the IP to avoid premature deletions
    connectedIPs.delete(req.normalizedIP);
    printConnectedIPs();
  });
});

// Start the servers
httpServer.listen(httpPort, () => {
  console.log(`HTTP server is running on http://localhost:${httpPort}`);
});

httpsServer.listen(httpsPort, () => {
  console.log(`HTTPS server is running on https://localhost:${httpsPort}`);
});
