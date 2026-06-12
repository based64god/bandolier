import { describe, expect, it } from "vitest";

import { parseAwsCredentials } from "~/app/dashboard/_components/parse-aws";

describe("parseAwsCredentials", () => {
  it("parses shell export statements", () => {
    const result = parseAwsCredentials(
      [
        'export AWS_ACCESS_KEY_ID="AKIA123"',
        'export AWS_SECRET_ACCESS_KEY="secret456"',
        'export AWS_SESSION_TOKEN="token789"',
        'export AWS_REGION="us-west-2"',
      ].join("\n"),
    );
    expect(result).toEqual({
      accessKeyId: "AKIA123",
      secretAccessKey: "secret456",
      sessionToken: "token789",
      region: "us-west-2",
    });
  });

  it("parses an ini/credentials-file block and skips the profile header", () => {
    const result = parseAwsCredentials(
      [
        "[default]",
        "aws_access_key_id = AKIA123",
        "aws_secret_access_key = secret456",
        "region = eu-central-1",
      ].join("\n"),
    );
    expect(result).toEqual({
      accessKeyId: "AKIA123",
      secretAccessKey: "secret456",
      region: "eu-central-1",
    });
  });

  it("parses Windows 'set' and PowerShell '$env:' prefixes", () => {
    expect(parseAwsCredentials("set AWS_ACCESS_KEY_ID=AKIA123")).toEqual({
      accessKeyId: "AKIA123",
    });
    expect(parseAwsCredentials('$env:AWS_ACCESS_KEY_ID="AKIA123"')).toEqual({
      accessKeyId: "AKIA123",
    });
  });

  it("maps alias spellings to canonical fields", () => {
    expect(
      parseAwsCredentials(
        "AWS_SECURITY_TOKEN=tok\nAWS_DEFAULT_REGION=us-east-1",
      ),
    ).toEqual({ sessionToken: "tok", region: "us-east-1" });
  });

  it("strips quotes, trailing semicolons, and surrounding whitespace", () => {
    expect(parseAwsCredentials('AWS_ACCESS_KEY_ID = "AKIA123" ;')).toEqual({
      accessKeyId: "AKIA123",
    });
    expect(parseAwsCredentials("AWS_ACCESS_KEY_ID='AKIA123'")).toEqual({
      accessKeyId: "AKIA123",
    });
  });

  it("ignores comment lines and blank lines", () => {
    expect(
      parseAwsCredentials("# a comment\n\nAWS_ACCESS_KEY_ID=AKIA123\n"),
    ).toEqual({ accessKeyId: "AKIA123" });
  });

  it("ignores keys it does not recognize", () => {
    expect(parseAwsCredentials("FOO=bar\nAWS_ACCESS_KEY_ID=AKIA123")).toEqual({
      accessKeyId: "AKIA123",
    });
  });

  it("ignores lines without an '=' separator", () => {
    expect(parseAwsCredentials("this is just prose")).toBeNull();
  });

  it("returns null when nothing matched", () => {
    expect(parseAwsCredentials("")).toBeNull();
    expect(parseAwsCredentials("hello world\nfoo bar")).toBeNull();
  });

  it("drops recognized keys with empty values", () => {
    expect(parseAwsCredentials("AWS_ACCESS_KEY_ID=")).toBeNull();
  });
});
