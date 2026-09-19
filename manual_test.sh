#!/bin/bash
set -e
EMAIL="manual_test_$(date +%s)@example.com"
echo "1. Registrando usuário $EMAIL"
curl -s -X POST http://localhost:3000/auth/register -H "Content-Type: application/json" -d "{\"email\": \"$EMAIL\", \"password\": \"password123\"}" > /dev/null

echo "2. Pegando token de confirmação no banco..."
TOKEN=$(docker compose exec -T db psql -U streamtube -t -c "SELECT token FROM verification_tokens vt JOIN users u ON u.id = vt.user_id WHERE u.email = '$EMAIL' LIMIT 1;" | xargs)

echo "3. Confirmando email..."
curl -s "http://localhost:3000/auth/confirm-email?token=$TOKEN" > /dev/null

echo "4. Fazendo login..."
LOGIN_RES=$(curl -s -X POST http://localhost:3000/auth/login -H "Content-Type: application/json" -d "{\"email\": \"$EMAIL\", \"password\": \"password123\"}")
ACCESS_TOKEN=$(echo $LOGIN_RES | grep -o '"access_token":"[^"]*' | cut -d'"' -f4)

echo "5. Criando vídeo (Draft)..."
SIZE=$(stat -c%s test_video.mp4)
DRAFT_RES=$(curl -s -X POST http://localhost:3000/videos -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" -d "{\"title\": \"Video de Teste Manual\", \"fileName\": \"test_video.mp4\", \"sizeInBytes\": $SIZE}")
VIDEO_ID=$(echo $DRAFT_RES | grep -o '"id":"[^"]*' | cut -d'"' -f4)
PUBLIC_ID=$(echo $DRAFT_RES | grep -o '"publicId":"[^"]*' | cut -d'"' -f4)
PART_URL=$(echo $DRAFT_RES | grep -o '"partUrls":\["[^"]*' | cut -d'"' -f4)

echo "Video ID: $VIDEO_ID"
echo "Public ID: $PUBLIC_ID"
echo "Part URL: $PART_URL"

echo "6. Fazendo upload de um arquivo real (pequeno)..."
UPLOAD_RES=$(curl -s -D - -X PUT "$PART_URL" --upload-file test_video.mp4)
ETAG=$(echo "$UPLOAD_RES" | grep -i ETag | awk '{print $2}' | tr -d '\r')

echo "ETag: $ETAG"

echo "7. Completando upload..."
COMPLETE_RES=$(curl -s -X POST http://localhost:3000/videos/$VIDEO_ID/upload/complete -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" -d "{\"parts\": [{\"PartNumber\": 1, \"ETag\": \"$ETAG\"}]}")
STATUS=$(echo $COMPLETE_RES | grep -o '"status":"[^"]*' | cut -d'"' -f4)
echo "Status após complete: $STATUS"

echo "8. Aguardando 5 segundos para o worker processar..."
sleep 5

echo "9. Buscando status atualizado..."
GET_RES=$(curl -s "http://localhost:3000/videos/$PUBLIC_ID")
FINAL_STATUS=$(echo $GET_RES | grep -o '"status":"[^"]*' | cut -d'"' -f4)
echo "Status final: $FINAL_STATUS"

echo "10. Logs do video-worker:"
docker compose logs --tail=50 video-worker
