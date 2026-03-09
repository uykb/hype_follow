.PHONY: build run clean

BINARY_NAME=hypefollow-bot

build:
	go build -o bin/$(BINARY_NAME) cmd/bot/main.go

run: build
	./bin/$(BINARY_NAME)

clean:
	rm -f bin/$(BINARY_NAME)
	rm -f bin/$(BINARY_NAME).exe
