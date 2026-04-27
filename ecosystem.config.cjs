module.exports = {
  apps: [
    {
      name: "pinata-voice-cooking-companion",
      script: "./server.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      env: {
        PORT: process.env.PORT || 3000,
        NODE_ENV: process.env.NODE_ENV || "production"
      }
    }
  ]
};
