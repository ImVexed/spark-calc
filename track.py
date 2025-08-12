import cv2
import numpy as np

video_path = "./video.mp4"  # Replace with your video
cap = cv2.VideoCapture(video_path)
fps = cap.get(cv2.CAP_PROP_FPS)
frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

coordinates = []
frame_num = 0

while cap.isOpened():
    ret, frame = cap.read()
    if not ret:
        break
    # Convert frame to grayscale and find the pinned element (e.g., a bright dot)
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    # Adjust threshold based on your pinned element (e.g., bright shape)
    _, thresh = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    if contours:
        # Get the largest contour (assumed to be the pinned element)
        c = max(contours, key=cv2.contourArea)
        M = cv2.moments(c)
        if M["m00"] != 0:
            cx = int(M["m10"] / M["m00"])  # X-coordinate of center
            cy = int(M["m01"] / M["m00"])  # Y-coordinate of center
            time_sec = frame_num / fps
            coordinates.append((frame_num, time_sec, cx, cy))
    
    frame_num += 1

cap.release()

# Save to CSV
with open("coordinates.csv", "w") as f:
    f.write("Frame,Time (s),X,Y\n")
    for frame, time, x, y in coordinates:
        f.write(f"{frame},{time:.4f},{x},{y}\n")

print("Coordinates saved to coordinates.csv")