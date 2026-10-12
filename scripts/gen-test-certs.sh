#!/usr/bin/env bash
# Generates TEST-ONLY TLS material used by the mock APNs server and the test suite.
# None of these keys or certificates have anything to do with Apple; never use them in production.
set -euo pipefail

OUT="$(cd "$(dirname "$0")/.." && pwd)/test/fixtures"
mkdir -p "$OUT"
cd "$OUT"

DAYS=36500
TOPIC="com.example.pushy"

# Certificate authority
openssl req -x509 -newkey rsa:2048 -nodes -days "$DAYS" \
  -keyout ca.key -out ca.pem -subj "/CN=pushy-ts test CA" 2>/dev/null

# Server certificate for localhost
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=localhost" 2>/dev/null
cat > server.ext <<EOF
subjectAltName = DNS:localhost, IP:127.0.0.1
extendedKeyUsage = serverAuth
EOF
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
  -days "$DAYS" -extfile server.ext -out server.pem 2>/dev/null

# Client certificate whose subject carries the base topic in the UID attribute, like Apple's push certificates
openssl req -newkey rsa:2048 -nodes -keyout client.key -out client.csr \
  -subj "/UID=${TOPIC}/CN=Apple Push Services: ${TOPIC}" 2>/dev/null
cat > client.ext <<EOF
extendedKeyUsage = clientAuth
EOF
openssl x509 -req -in client.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
  -days "$DAYS" -extfile client.ext -out client.pem 2>/dev/null

# The same client credentials bundled as PKCS#12 (password: "pushy-test")
openssl pkcs12 -export -inkey client.key -in client.pem -out client.p12 -passout pass:pushy-test 2>/dev/null

# A test token-signing key in the same PKCS#8 PEM shape as Apple's AuthKey_XXXXXXXXXX.p8 files
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out token-auth-private-key.p8 2>/dev/null
openssl pkey -in token-auth-private-key.p8 -pubout -out token-auth-public-key.pem 2>/dev/null

rm -f ./*.csr ./*.ext ./*.srl ca.key
echo "Wrote test fixtures to $OUT"
