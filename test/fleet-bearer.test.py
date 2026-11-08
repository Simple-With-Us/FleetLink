"""Shared fleet identity adapter, offline and with synthetic credentials only."""
import importlib.machinery
import importlib.util
import io
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader("fleet_cli", str(Path(__file__).parents[1] / "cli/fleet-share"))
spec = importlib.util.spec_from_loader(loader.name, loader)
F = importlib.util.module_from_spec(spec)
loader.exec_module(F)


class FleetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name).resolve() / "token"
        self.path.write_text("sbt_codex_" + "x" * 43)
        self.path.chmod(0o600)
        self.args = SimpleNamespace(fleet_bearer_file=str(self.path), token=None, operator=False, domain=None)
        self.api = F.FleetApi(self.args)

    def tearDown(self):
        self.tmp.cleanup()



    def test_gateway_refusal_uses_worker_machine_code_without_echoing_reason(self):
        import json
        marker = "internal valve state bucket 7 detail"
        result = {"jsonrpc": "2.0", "id": 1, "result": {
            "isError": True,
            "structuredContent": {"code": "invalid_arguments"},
            "content": [{"type": "text", "text": "days: invalid; detail " + marker + " \u001b[31mred"}]}}
        response = io.BytesIO(json.dumps(result).encode())
        response.headers = {"Content-Type": "application/json"}
        with patch.object(F, "gateway_transport") as opener:
            opener.return_value.open.return_value = response
            with self.assertRaises(F.FleetError) as ctx:
                F.Client(self.path).rpc("tools/call", {}, True)
        self.assertEqual(ctx.exception.code, "invalid_arguments")
        self.assertNotIn(marker, str(ctx.exception))
        self.assertNotIn("\x1b", str(ctx.exception))

    def test_gateway_refusal_without_code_falls_back_without_echoing_reason(self):
        import json
        result = {"jsonrpc": "2.0", "id": 1, "result": {
            "isError": True,
            "content": [{"type": "text", "text": "some internal detail"}]}}
        response = io.BytesIO(json.dumps(result).encode())
        response.headers = {"Content-Type": "application/json"}
        with patch.object(F, "gateway_transport") as opener:
            opener.return_value.open.return_value = response
            with self.assertRaises(F.FleetError) as ctx:
                F.Client(self.path).rpc("tools/call", {}, True)
        self.assertEqual(ctx.exception.code, "upstream_error")
        self.assertNotIn("some internal detail", str(ctx.exception))

    def test_malformed_error_content_fails_closed_without_crash(self):
        import json
        for content in (["not-a-dict"], [{"type": "text"}], "text", 5, None):
            result = {"jsonrpc": "2.0", "id": 1, "result": {"isError": True, "content": content}}
            response = io.BytesIO(json.dumps(result).encode())
            response.headers = {"Content-Type": "application/json"}
            with patch.object(F, "gateway_transport") as opener:
                opener.return_value.open.return_value = response
                with self.assertRaises(F.FleetError) as ctx:
                    F.Client(self.path).rpc("tools/call", {}, True)
            self.assertIn(ctx.exception.code, ("upstream_error", "outcome_unknown"))

    def test_prefix_or_verb_position_never_loses_bearer_mode(self):
        for argv in (["--fleet-bearer-file", str(self.path), "whoami"], ["whoami", "--fleet-bearer-file", str(self.path)]):
            args = F.build_parser().parse_args(argv)
            self.assertEqual(args.fleet_bearer_file, str(self.path))
            self.assertIsInstance(F.Api(args), F.FleetApi)

    def test_decoded_unicode_reflection_and_request_containing_bearer_refused(self):
        import json
        token = "sbt_codex_" + "x" * 43
        escaped = "\\u0073" + token[1:]
        raw = ('{"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"nested":["' + escaped + '"]}}}').encode()
        response = io.BytesIO(raw)
        response.headers = {"Content-Type": "application/json"}
        with patch.object(F, "gateway_transport") as opener:
            opener.return_value.open.return_value = response
            with self.assertRaises(F.FleetError):
                F.Client(self.path).rpc("tools/call", {}, True)
        with patch.object(F, "gateway_transport") as opener:
            with self.assertRaises(F.FleetError):
                F.Client(self.path).rpc("tools/call", json.loads('{"nested":["' + escaped + '"]}'), True)
            opener.return_value.open.assert_not_called()

    def test_empty_prefix_or_verb_option_never_reaches_legacy_auth(self):
        for argv in (["--fleet-bearer-file", "", "whoami"], ["whoami", "--fleet-bearer-file", ""]):
            args = F.build_parser().parse_args(argv)
            with patch.object(F, "resolve_auth") as legacy:
                with self.assertRaises(F.FleetError):
                    F.Api(args)
                legacy.assert_not_called()

    def test_invalid_fenced_json_and_numeric_options_are_cli_errors(self):
        answer = {"content": [{"text": "BEGIN_UNTRUSTED_FLEETLINK nonce=abc\n{bad}\nEND_UNTRUSTED_FLEETLINK nonce=abc"}]}
        with patch.object(self.api.client, "call", return_value=answer):
            with self.assertRaises(F.CliError):
                self.api.tool("fleetlink_read_file", {})
        with patch.object(self.api, "tool") as tool:
            for path, method, body in (("/api/shares?limit=no", "GET", None), ("/api/shares", "POST", {"days": "no"}), ("/api/shares/demo/renew", "POST", {"days": "NaN"}), ("/api/links", "POST", {"days": "Infinity"})):
                with self.assertRaises(F.CliError):
                    self.api.request(method, path, body)
            tool.assert_not_called()

    def test_python38_credential_reader_avoids_post38_string_methods(self):
        import inspect
        self.assertNotIn("removesuffix", inspect.getsource(F.private_bearer))
        self.assertNotIn("removeprefix", inspect.getsource(F.private_bearer))

    def test_gateway_keepalive_and_unknown_write_http_statuses(self):
        import urllib.error
        with patch.object(F.http.client, "HTTPSConnection") as tls:
            response = tls.return_value.getresponse.return_value
            response.status = 200
            transport = F.GatewayTransport()
            request = F.urllib.request.Request(F.ENDPOINT, data=b"{}", method="POST")
            transport.open(request)
            transport.open(request)
            self.assertEqual(tls.call_count, 1)
            self.assertEqual(tls.return_value.request.call_count, 2)
        for status in (408, 429, 500):
            with patch.object(F, "gateway_transport") as factory:
                factory.return_value.open.side_effect = urllib.error.HTTPError(F.ENDPOINT, status, "refuse", {}, None)
                with self.assertRaises(F.FleetError) as exc:
                    F.Client(self.path).rpc("tools/call", {}, True)
                self.assertEqual(exc.exception.code, "outcome_unknown")
                self.assertEqual(factory.return_value.open.call_count, 1)
        self.assertEqual(F.canonical_hint("Grok (Build)"), "GROK")

    def test_bool_numeric_values_refused_before_gateway_call(self):
        with patch.object(self.api, "tool") as tool:
            for value in (True, False):
                for path, method, body in (("/api/shares", "POST", {"days": value}), ("/api/shares/demo/renew", "POST", {"days": value}), ("/api/links", "POST", {"days": value})):
                    with self.assertRaises(F.CliError):
                        self.api.request(method, path, body)
                with self.assertRaises(F.CliError):
                    self.api.number(value, int, "limit")
            tool.assert_not_called()

    def test_alias_spelling_is_not_a_different_valid_bearer_identity(self):
        self.path.write_text("sbt_instinct_" + "x" * 43)
        client = F.Client(self.path)
        with patch.object(client, "rpc", return_value={"structuredContent": {"seat": "WISE", "authenticated_seat": "WISE"}}) as rpc:
            with self.assertRaises(F.FleetError):
                client.call("fleetlink_whoami", {})
            self.assertEqual(rpc.call_count, 1)
        with self.assertRaises(F.FleetError):
            F.Client(self.path, identity_env={"AGENT_SEAT": "WISE"})

    def test_same_client_private_file_behavior(self):
        self.assertEqual(self.api.client.seat, "CODEX")
        self.path.chmod(0o644)
        with self.assertRaises(F.FleetError):
            F.FleetApi(self.args)

    def test_no_provider_token_or_domain_mix(self):
        for field, value in (("token", "bad"), ("domain", "https://example.com")):
            args = SimpleNamespace(**vars(self.args))
            setattr(args, field, value)
            with self.assertRaises(F.CliError):
                F.FleetApi(args)

    def test_rest_mapping_empty_reuse_large_stream_and_options(self):
        with patch.object(self.api, "tool", return_value={"share": {"slug": "demo"}}) as tool:
            self.api.post("/api/shares", {"slug": "demo", "reuse": True, "password": "hi", "days": "forever", "personal": True})
            self.assertEqual(tool.call_args.args, ("fleetlink_create_share", {"slug": "demo", "reuse": True, "password": "hi", "days": "forever", "personal": True, "empty": True}))
        with patch.object(self.api, "tool", return_value={"upload": {}}) as tool, patch.object(self.api, "stream", return_value={"url": "url"}) as stream:
            body = io.BytesIO(b"abc")
            self.api.request("PUT", "/api/shares/demo/files/docs/a.bin", data=body, headers={"Content-Type": "application/octet-stream"}, length=300_000_000)
            self.assertIs(stream.call_args.args[1], body)
            self.assertEqual(tool.call_args.args[1]["path"], "docs/a.bin")
            self.assertEqual(tool.call_args.args[1]["max_bytes"], 300_000_000)

    def test_account_operations_fail_closed(self):
        with patch.object(self.api, "tool") as tool:
            for path in ("/api/tokens", "/api/admin/users", "/api/bots"):
                with self.assertRaises(F.CliError):
                    self.api.get(path)
            tool.assert_not_called()

    def grant(self, **changes):
        out = {"upload_url": "https://fleetlink.online/api/uploads/flu_" + "a" * 64, "path": "a.bin", "max_bytes": 100, "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(), "content_type": "application/octet-stream"}
        out.update(changes)
        return {"upload": out, "share": {"slug": "demo"}}

    def test_signed_upload_issuer_object_expiry_size_bound_before_network(self):
        for changes in ({"upload_url": "https://evil.test/api/uploads/flu_" + "a" * 64}, {"path": "other"}, {"expires_at": "2020-01-01T00:00:00+00:00"}, {"max_bytes": 1}, {"upload_url": "https://fleetlink.online/api/uploads/flu_" + "a" * 64 + "?x=1"}):
            with patch.object(F.urllib.request, "build_opener") as opener:
                with self.assertRaises(F.CliError):
                    self.api.stream(self.grant(**changes), io.BytesIO(b"abc"), 3, "a.bin", "demo")
                opener.return_value.open.assert_not_called()

    def test_stream_has_no_bearer_no_retry_no_cleanup_on_failure(self):
        with patch.object(F.urllib.request, "build_opener") as opener:
            opener.return_value.open.side_effect = OSError("synthetic")
            with self.assertRaises(F.CliError) as exc:
                self.api.stream(self.grant(), io.BytesIO(b"abc"), 3, "a.bin", "demo")
            self.assertIn("outcome unknown", str(exc.exception))
            request = opener.return_value.open.call_args.args[0]
            self.assertNotIn("Authorization", request.headers)
            self.assertEqual(opener.return_value.open.call_count, 1)

    def test_nonce_paired_data_fence_not_truncated_summary(self):
        data = {"encoding": "base64", "content": "YWJj"}
        import json
        answer = {"content": [{"type": "text", "text": "header\nBEGIN_UNTRUSTED_FLEETLINK nonce=abc123\n" + json.dumps(data) + "\nEND_UNTRUSTED_FLEETLINK nonce=abc123"}], "structuredContent": {}}
        with patch.object(self.api.client, "call", return_value=answer):
            self.assertEqual(self.api.tool("fleetlink_read_file", {}), data)
        answer["content"][0]["text"] = answer["content"][0]["text"].replace("END_UNTRUSTED_FLEETLINK nonce=abc123", "END_UNTRUSTED_FLEETLINK nonce=bad")
        with patch.object(self.api.client, "call", return_value=answer):
            with self.assertRaises(F.CliError):
                self.api.tool("fleetlink_read_file", {})


if __name__ == "__main__":
    unittest.main()
