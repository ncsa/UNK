#!/bin/bash
# Start UNK Fighter. Needs UNK_HOSTNAME and ACME_EMAIL for the HTTPS deployment; see DEPLOY.md.

#nohup ./server.py > server.log 2>&1 &

docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --build
