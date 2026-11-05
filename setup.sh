#!/bin/bash
# Deployment settings for the HTTPS setup (start.sh / docker-compose.https.yml).
# SOURCE this (don't execute it) so the exports reach your shell:
#
#     source setup.sh
#     ./start.sh
#
# Nothing else is needed on a server: the Docker image brings its own Python.
# The asset tools read their keys from gemini_key.txt / elevenlabs_key.txt themselves.

export UNK_HOSTNAME=docent.ncsa.illinois.edu
export ACME_EMAIL=mchenry@illinois.edu
echo "unk: UNK_HOSTNAME=$UNK_HOSTNAME ACME_EMAIL=$ACME_EMAIL"
