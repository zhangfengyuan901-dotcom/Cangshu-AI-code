#!/usr/bin/env python3
"""Minimal SOCKS5 stdio relay for OpenSSH ProxyCommand on Windows."""

from __future__ import annotations

import argparse
import socket
import struct
import sys
import threading


def recv_exact(sock: socket.socket, size: int) -> bytes:
    data = bytearray()
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise ConnectionError("SOCKS5 proxy closed the connection")
        data.extend(chunk)
    return bytes(data)


def connect_socks5(proxy_host: str, proxy_port: int, host: str, port: int) -> socket.socket:
    sock = socket.create_connection((proxy_host, proxy_port), timeout=15)
    sock.sendall(b"\x05\x01\x00")
    if recv_exact(sock, 2) != b"\x05\x00":
        raise ConnectionError("SOCKS5 proxy rejected unauthenticated access")

    encoded_host = host.encode("idna")
    if len(encoded_host) > 255:
        raise ValueError("target hostname is too long")
    request = b"\x05\x01\x00\x03" + bytes([len(encoded_host)]) + encoded_host + struct.pack("!H", port)
    sock.sendall(request)

    version, reply, _reserved, address_type = recv_exact(sock, 4)
    if version != 5 or reply != 0:
        raise ConnectionError(f"SOCKS5 connect failed with reply code {reply}")
    if address_type == 1:
        recv_exact(sock, 4)
    elif address_type == 3:
        recv_exact(sock, recv_exact(sock, 1)[0])
    elif address_type == 4:
        recv_exact(sock, 16)
    else:
        raise ConnectionError(f"SOCKS5 returned unknown address type {address_type}")
    recv_exact(sock, 2)
    sock.settimeout(None)
    return sock


def relay_stdin(sock: socket.socket) -> None:
    try:
        # read1() returns currently available pipe data; read() may wait for the
        # full buffer and deadlock the SSH handshake on Windows.
        while chunk := sys.stdin.buffer.read1(65536):
            sock.sendall(chunk)
    finally:
        try:
            sock.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("host")
    parser.add_argument("port", type=int)
    parser.add_argument("--proxy-host", default="127.0.0.1")
    parser.add_argument("--proxy-port", type=int, default=10808)
    args = parser.parse_args()

    try:
        with connect_socks5(args.proxy_host, args.proxy_port, args.host, args.port) as sock:
            threading.Thread(target=relay_stdin, args=(sock,), daemon=True).start()
            while chunk := sock.recv(65536):
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
    except Exception as exc:
        print(f"socks5_proxy: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
