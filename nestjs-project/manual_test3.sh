#!/bin/bash
set -e
EMAIL="manual_test_$(date +%s)@example.com"
echo "0. Limpando emails no Mailpit..."
curl -s -X DELETE http://mailpit:8025/api/v1/messages > /dev/null

echo "1. Registrando usuário $EMAIL"
curl -s -i -X POST http://localhost:3000/auth/register -H "Content-Type: application/json" -d "{\"email\": \"$EMAIL\", \"password\": \"password123\"}"

echo -e "\n2. Pegando token de confirmação no Mailpit..."
sleep 2
MSG_ID=$(curl -s http://mailpit:8025/api/v1/messages | jq -r '.messages[0].ID')
TOKEN=$(curl -s "http://mailpit:8025/api/v1/message/$MSG_ID" | jq -r '.Text' | grep -o 'token=[A-Za-z0-9_-]*' | head -1 | cut -d= -f2)

echo "3. Confirmando email... ($TOKEN)"
curl -s -i "http://localhost:3000/auth/confirm-email?token=$TOKEN"

echo -e "\n4. Fazendo login..."
LOGIN_RES=$(curl -s -X POST http://localhost:3000/auth/login -H "Content-Type: application/json" -d "{\"email\": \"$EMAIL\", \"password\": \"password123\"}")
ACCESS_TOKEN=$(echo $LOGIN_RES | grep -o '"access_token":"[^"]*' | cut -d'"' -f4)

echo "5. Criando vídeo (Draft)..."
SIZE=$(stat -c%s test_video.mp4)
DRAFT_RES=$(curl -s -i -X POST http://localhost:3000/videos -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" -d "{\"title\": \"Video de Teste Manual\", \"fileName\": \"test_video.mp4\", \"sizeInBytes\": $SIZE}")
echo "$DRAFT_RES"

VIDEO_ID=$(echo "$DRAFT_RES" | grep -o '"id":"[^"]*' | cut -d'"' -f4)
PUBLIC_ID=$(echo "$DRAFT_RES" | grep -o '"publicId":"[^"]*' | cut -d'"' -f4)
PART_URL=$(echo "$DRAFT_RES" | grep -o '"partUrls":\["[^"]*' | cut -d'"' -f4 | sed 's/\\u0026/\&/g')

echo -e "\nVideo ID: $VIDEO_ID"
echo "Public ID: $PUBLIC_ID"
echo "Part URL: $PART_URL"

echo -e "\n6. Fazendo upload de um arquivo real (pequeno)..."
UPLOAD_RES=$(curl -s -D - -X PUT "$PART_URL" --upload-file test_video.mp4)
ETAG=$(echo "$UPLOAD_RES" | grep -i ETag | awk '{print $2}' | tr -d '\r' | tr -d '"')

echo "ETag: $ETAG"

echo -e "\n7. Completando upload..."
COMPLETE_RES=$(curl -s -i -X POST http://localhost:3000/videos/$VIDEO_ID/upload/complete -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" -d "{\"parts\": [{\"PartNumber\": 1, \"ETag\": \"$ETAG\"}]}")
echo "$COMPLETE_RES"

echo -e "\n8. Aguardando 15 segundos para o worker processar..."
sleep 15

echo -e "\n9. Buscando status atualizado..."
GET_RES=$(curl -s -i "http://localhost:3000/videos/$PUBLIC_ID")
echo "$GET_RES"

echo -e "\n10. Testando Stream (GET /videos/$PUBLIC_ID/stream)..."
curl -s -I "http://localhost:3000/videos/$PUBLIC_ID/stream"

echo -e "\n11. Testando Download (GET /videos/$PUBLIC_ID/download)..."
curl -s -I "http://localhost:3000/videos/$PUBLIC_ID/download"
