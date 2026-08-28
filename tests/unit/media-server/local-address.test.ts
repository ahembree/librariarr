import { describe, it, expect } from "vitest";
import { isPrivateAddress } from "@/lib/media-server/local-address";

describe("isPrivateAddress", () => {
  describe("IPv4 private ranges", () => {
    it.each([
      "10.0.0.1",
      "10.255.255.254",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.50",
      "127.0.0.1",
      "169.254.10.10",
      "100.64.0.1", // CGNAT / tailnet
      "100.127.255.254",
    ])("treats %s as private", (ip) => {
      expect(isPrivateAddress(ip)).toBe(true);
    });

    it.each([
      "8.8.8.8",
      "1.1.1.1",
      "172.15.0.1", // just below the /12
      "172.32.0.1", // just above the /12
      "192.169.1.1",
      "100.63.255.255", // just below the CGNAT block
      "100.128.0.1", // just above the CGNAT block
      "169.253.0.1",
      "203.0.113.9",
    ])("treats %s as public", (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    });
  });

  describe("port stripping", () => {
    it("strips an IPv4 port", () => {
      expect(isPrivateAddress("192.168.1.50:54321")).toBe(true);
      expect(isPrivateAddress("8.8.8.8:443")).toBe(false);
    });

    it("strips a bracketed IPv6 port", () => {
      expect(isPrivateAddress("[::1]:8096")).toBe(true);
      expect(isPrivateAddress("[fd12:3456::1]:8096")).toBe(true);
      expect(isPrivateAddress("[2606:4700::1111]:443")).toBe(false);
    });

    it("does not mistake IPv6 colons for a port separator", () => {
      expect(isPrivateAddress("fd12:3456:789a::1")).toBe(true);
      expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
    });
  });

  describe("IPv6", () => {
    it("treats loopback, ULA and link-local as private", () => {
      expect(isPrivateAddress("::1")).toBe(true);
      expect(isPrivateAddress("fc00::1")).toBe(true);
      expect(isPrivateAddress("fd9e:21a7:a92c::1")).toBe(true);
      expect(isPrivateAddress("fe80::1")).toBe(true);
      expect(isPrivateAddress("febf::1")).toBe(true);
    });

    it("treats global unicast as public", () => {
      expect(isPrivateAddress("2001:4860:4860::8888")).toBe(false);
      expect(isPrivateAddress("fec0::1")).toBe(false); // outside fe80::/10
      expect(isPrivateAddress("face:b00c::1")).toBe(false);
    });

    it("strips a zone index", () => {
      expect(isPrivateAddress("fe80::1%eth0")).toBe(true);
    });

    it("classifies IPv4-mapped addresses by their IPv4 part", () => {
      expect(isPrivateAddress("::ffff:192.168.1.10")).toBe(true);
      expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
    });
  });

  describe("non-addresses", () => {
    it("is false for missing input", () => {
      expect(isPrivateAddress(undefined)).toBe(false);
      expect(isPrivateAddress(null)).toBe(false);
      expect(isPrivateAddress("")).toBe(false);
    });

    it("does not treat a hostname starting with fc/fd as a ULA", () => {
      expect(isPrivateAddress("fd-cdn.example.com")).toBe(false);
      expect(isPrivateAddress("fcbank.example.com")).toBe(false);
    });

    it("rejects out-of-range IPv4 octets", () => {
      expect(isPrivateAddress("999.168.1.1")).toBe(false);
      expect(isPrivateAddress("192.300.1.1")).toBe(false);
    });
  });
});
