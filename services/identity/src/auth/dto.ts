import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { Equals, IsEmail, IsOptional, IsString, Length, Matches, MaxLength } from "class-validator";

/** Collapse runs of whitespace and trim, so "  Asha   Rao " is stored as "Asha Rao". */
const tidy = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : value;

const lowerTrim = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim().toLowerCase() || null : value;

/**
 * Letters in any script (Devanagari and Gurmukhi included, hence \p{M} for
 * combining vowel signs), digits, and the punctuation real names contain.
 * Starts with a letter, so no leading punctuation or control characters.
 */
const NAME = /^[\p{L}\p{M}][\p{L}\p{M}\p{N} .'’-]*$/u;

export class RequestOtpDto {
  @ApiProperty({ example: "98765 43210", description: "An Indian mobile number. +91, spaces and dashes are accepted." })
  @IsString()
  @MaxLength(24)
  phone!: string;
}

export class VerifyOtpDto {
  @ApiProperty({ example: "9876543210" })
  @IsString()
  @MaxLength(24)
  phone!: string;

  @ApiProperty({ example: "123456" })
  @IsString()
  @Length(4, 8)
  code!: string;
}

export class SignupDto {
  @ApiProperty({ description: "The `signupToken` returned by /otp/verify for a number with no account." })
  @IsString()
  @MaxLength(2000)
  signupToken!: string;

  @ApiProperty({ example: "Asha Rao" })
  @Transform(tidy)
  @IsString()
  @Length(2, 80)
  @Matches(NAME, { message: "name must contain only letters, spaces and . ' -" })
  name!: string;

  @ApiPropertyOptional({ example: "asha@example.com" })
  @IsOptional()
  @Transform(lowerTrim)
  @IsEmail()
  @MaxLength(255)
  email?: string | null;

  @ApiProperty({ description: "Must be true: agreement to the terms of use." })
  @Equals(true, { message: "You must accept the terms to create an account." })
  acceptTerms!: true;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  @Length(20, 200)
  refreshToken!: string;
}

export class UpdateProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(tidy)
  @IsString()
  @Length(2, 80)
  @Matches(NAME, { message: "name must contain only letters, spaces and . ' -" })
  name?: string;

  @ApiPropertyOptional({ nullable: true, description: "null removes the email." })
  @IsOptional()
  @Transform(lowerTrim)
  @IsEmail()
  @MaxLength(255)
  email?: string | null;
}
