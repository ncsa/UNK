#!/bin/bash

#pkill -f server.py

docker compose -f docker-compose.yml -f docker-compose.https.yml down
