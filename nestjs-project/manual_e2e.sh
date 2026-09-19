#!/bin/bash
set -e

EMAIL="manual_e2e_$(date +%s)@example.com"
echo "========================================"
echo "TESTE MANUAL E2E — PIPELINE DE VÍDEO"
echo "========================================"
echo ""

# Step 0: Limpa emails
echo "[1/9] Registrando usuário: $EMAIL"
curl -s -X DELETE http://localhost:8025/api/v1/messages > /dev/null
curl -s -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$EMAIL\", \"password\": \"password123\"}" | jq '.'

# Step 1: Pega token no mailpit
echo ""
echo "[2/9] Aguardando email de confirmação..."
sleep 2
MSG_RESP=$(curl -s http://localhost:8025/api/v1/messages)
MSG_COUNT=$(echo $MSG_RESP | jq '.messages | length')
if [ "$MSG_COUNT" -eq "0" ]; then
  echo "ERRO: Nenhum email recebido no Mailpit!"
  exit 1
fi
MSG_ID=$(echo $MSG_RESP | jq -r '.messages[0].ID')
EMAIL_TEXT=$(curl -s "http://localhost:8025/api/v1/message/$MSG_ID" | jq -r '.Text // .HTML')
CONF_TOKEN=$(echo "$EMAIL_TEXT" | grep -oP '(?<=token=)[A-Za-z0-9_-]+' | head -1)
echo "Token de confirmação: ${CONF_TOKEN:0:20}..."

# Step 2: Confirma email
echo ""
echo "[3/9] Confirmando email..."
CONFIRM_RESP=$(curl -s "http://localhost:3000/auth/confirm-email?token=$CONF_TOKEN")
echo "Resposta: $CONFIRM_RESP"

# Step 3: Login
echo ""
echo "[4/9] Login..."
LOGIN_RESP=$(curl -s -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$EMAIL\", \"password\": \"password123\"}")
echo "$LOGIN_RESP" | jq 'del(.access_token, .refresh_token) + {access_token: "***", refresh_token: "***"}'
ACCESS_TOKEN=$(echo $LOGIN_RESP | jq -r '.access_token')

# Step 4: Cria vídeo (Draft)
echo ""
echo "[5/9] Criando vídeo draft..."
VIDEO_SIZE=$(stat -c%s test_video.mp4)
DRAFT_RESP=$(curl -s -X POST http://localhost:3000/videos \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"title\": \"Teste E2E Manual\", \"fileName\": \"test_video.mp4\", \"sizeInBytes\": $VIDEO_SIZE}")
echo "$DRAFT_RESP" | jq '{ id, publicId, status, uploadId, "partUrls_count": (.partUrls | length) }'
VIDEO_ID=$(echo $DRAFT_RESP | jq -r '.id')
PUBLIC_ID=$(echo $DRAFT_RESP | jq -r '.publicId')
PART_URL=$(echo $DRAFT_RESP | jq -r '.partUrls[0]')

echo "→ Video ID: $VIDEO_ID"
echo "→ Public ID: $PUBLIC_ID"

# Step 5: Upload real para MinIO
echo ""
echo "[6/9] Fazendo upload real do arquivo para MinIO via presigned URL..."
UPLOAD_HEADERS=$(curl -s -D - -X PUT "$PART_URL" \
  --upload-file test_video.mp4 \
  -o /dev/null)
ETAG=$(echo "$UPLOAD_HEADERS" | grep -i '^ETag:' | tr -d '\r\n' | sed 's/ETag: *//' | tr -d '"')
echo "→ ETag retornado: $ETAG"

# Step 6: Completa upload
echo ""
echo "[7/9] Completando upload (enfileirando job BullMQ)..."
COMPLETE_RESP=$(curl -s -X POST "http://localhost:3000/videos/$VIDEO_ID/upload/complete" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"parts\": [{\"PartNumber\": 1, \"ETag\": \"$ETAG\"}]}")
echo "$COMPLETE_RESP" | jq '.'

# Step 7: Aguarda processamento
echo ""
echo "[8/9] Aguardando worker processar (15s)..."
sleep 15

# Step 8: Verifica status final
echo ""
echo "[9/9] GET /videos/$PUBLIC_ID:"
FINAL_RESP=$(curl -s "http://localhost:3000/videos/$PUBLIC_ID")
echo "$FINAL_RESP" | jq '.'
FINAL_STATUS=$(echo $FINAL_RESP | jq -r '.status')

echo ""
echo "========================================"
echo "STATUS FINAL: $FINAL_STATUS"
echo "========================================"
