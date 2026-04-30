default:
    @just --list

test:
    cargo fmt --check
    cargo check
